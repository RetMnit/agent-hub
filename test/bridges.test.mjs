import test from 'node:test';
import assert from 'node:assert/strict';
import { codexBridge, dshBridge, CLIENT } from '../daemon/bridges.mjs';

test('the Codex adapter names the session in each requestId and hands it back', async () => {
  const calls = [];
  const codex = codexBridge({ connect: async () => ({ call: async (method, params) => {
    calls.push([method, params]);
    return method === 'events' ? { cursor: 3, jobs: [{ jobId: 'j1', requestId: 'session-a:r1', status: 'running' }] } : { jobId: 'j1', requestId: params.requestId, status: 'starting' };
  } }) });
  const job = await codex.start('session-a', { mode: 'desktop', workspace: 'W', effort: 'low' }, { prompt: 'p', requestId: 'r1', title: 'T' });
  assert.deepEqual(calls[0], ['start', { client: CLIENT, workspace: 'W', effort: 'low', prompt: 'p', requestId: 'session-a:r1', title: 'T' }]);
  await codex.resume('session-a', { sessionId: 't1', mode: 'desktop', prompt: 'more', requestId: 'r2' });
  assert.equal('mode' in calls.at(-1)[1], false, 'Codex runs are always hidden: no mode reaches the bridge');
  assert.equal(job.owner, 'session-a'); assert.equal(job.requestId, 'r1'); assert.equal(job.backend, 'codex');
  const events = await codex.events({ cursor: 2, timeoutMs: 10 });
  assert.deepEqual(calls.at(-1), ['events', { client: CLIENT, afterCursor: 2, timeoutMs: 10 }]);
  assert.equal(events.jobs[0].owner, 'session-a');
});

test('the DSH adapter starts a Host to dispatch, never to watch, and reads DSH\'s menus into one shape', async () => {
  const calls = [];
  const dsh = dshBridge({ connect: () => ({
    defaults: { workspace: 'W', permission: 'danger-full-access' },
    focusDesktop() { calls.push(['focus']); },
    call: async (mode, method, params, options = {}) => {
      calls.push([mode, method, params, options.start ?? true]);
      if (method === 'catalog') return {
        presets: { presets: [{ id: 'standard', isDefault: true }, { id: 'unity', name: 'Unity' }] },
        models: { default: { provider: 'acct', model: 'flash', reasoningEffort: 'high' }, groups: [{ id: 'acct', name: 'Account', models: [{ id: 'flash', name: 'Flash', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } }] }] },
        permissions: { options: [{ value: 'read-only' }], defaultPreset: 'read-only' },
      };
      if (method === 'events') return { instanceId: 'i1', cursor: 1, jobs: [{ jobId: 'j1', requestId: 'session-a:r1', mode, status: 'waiting-user', createdAt: 'now', events: [{ type: 'tool/call', tool: 'shell' }], effective: { workspace: 'W', preset: 'unity', model: { provider: 'acct', model: 'flash', reasoningEffort: 'high' } } }] };
      return { jobId: 'j1', requestId: params.requestId, mode, status: 'starting', createdAt: 'now' };
    },
  }) });
  const job = await dsh.start('session-a', { mode: 'desktop', workspace: 'W', preset: 'unity' }, { prompt: 'p', requestId: 'r1' });
  assert.deepEqual(calls[0], ['desktop', 'start', { client: CLIENT, workspace: 'W', preset: 'unity', prompt: 'p', requestId: 'session-a:r1' }, true]);
  assert.equal(job.owner, 'session-a'); assert.equal(job.status, 'running');
  await dsh.resume('session-a', { sessionId: 's1', mode: 'headless', prompt: 'more', requestId: 'r2' });
  assert.deepEqual(calls[1].slice(0, 3), ['headless', 'start', { client: CLIENT, sessionId: 's1', prompt: 'more', requestId: 'session-a:r2' }]);
  const events = await dsh.events({ mode: 'headless', timeoutMs: 10 });
  assert.equal(calls[2][3], false, 'watching never starts a Host');
  assert.deepEqual([events.jobs[0].status, events.jobs[0].phase, events.jobs[0].activity[0].text, events.jobs[0].settings.preset], ['waiting', 'waiting-user', 'shell', 'unity']);
  await dsh.events({ mode: 'headless', cursor: 1, timeoutMs: 10 });
  assert.equal(calls[3][2].instanceId, 'i1', 'a long poll names the Host it last heard from');
  await dsh.cancel('j1', 'headless');
  assert.equal(calls[4][3], false);
  const menus = await dsh.catalog();
  assert.deepEqual(menus.models, [{ provider: 'acct', providerName: 'Account', id: 'flash', name: 'Flash', efforts: ['low', 'high'], defaultEffort: 'high' }]);
  assert.deepEqual(menus.defaults, { preset: 'standard', model: 'flash', provider: 'acct', effort: 'high', permission: 'read-only' });
  await dsh.open({ sessionId: 's1' });
  assert.deepEqual(calls.at(-1), ['focus']);
});
