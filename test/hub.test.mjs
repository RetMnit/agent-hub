import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-'));
fs.mkdirSync(path.join(temp, 'beta'));
const { createHub } = await import('../daemon/hub.mjs');

// Stands in for a bridge: jobs live in memory and `finish` ends one, the way a
// bridge reports a run that completed.
function fakeBackend(name, extra = {}) {
  const jobs = new Map();
  const bus = new EventEmitter();
  let cursor = 0, next = 0;
  const bump = () => { cursor++; bus.emit('change'); };
  const calls = [];
  const backend = {
    name, calls, jobs, offline: false,
    catalog: async () => ({ models: [], permissions: [], projects: [{ id: 'p1', name: 'Alpha', root: temp }, { id: 'p2', name: 'Beta', root: path.join(temp, 'beta') }], defaults: { project: 'p1' } }),
    defaults: async () => ({ workspace: temp, permission: 'danger-full-access' }),
    sessions: async params => { calls.push(['sessions', params]); return { sessions: [] }; },
    start: async (owner, settings, task) => {
      calls.push(['start', owner, settings, task]);
      const job = { jobId: name + '-' + ++next, backend: name, owner, requestId: task.requestId, mode: settings.mode, title: task.title, sessionId: name + '-session-' + next,
        status: 'running', createdAt: new Date(Date.now() + next).toISOString(), promptSummary: task.prompt, activity: [] };
      jobs.set(job.jobId, job); bump(); return { ...job };
    },
    resume: async (owner, task) => {
      calls.push(['resume', owner, task]);
      const job = { jobId: name + '-' + ++next, backend: name, owner, requestId: task.requestId, mode: task.mode, sessionId: task.sessionId, status: 'running', createdAt: new Date().toISOString(), activity: [] };
      jobs.set(job.jobId, job); bump(); return { ...job };
    },
    status: async jobId => ({ ...jobs.get(jobId), prompt: 'the whole prompt' }),
    cancel: async jobId => { Object.assign(jobs.get(jobId), { status: 'cancelled', finishedAt: new Date().toISOString() }); bump(); return { ...jobs.get(jobId) }; },
    open: async params => { calls.push(['open', params]); return { opened: true }; },
    events: async ({ cursor: after, timeoutMs }) => {
      if (backend.offline) throw new Error('Host is not running');
      if (after === cursor) await new Promise(resolve => { const timer = setTimeout(resolve, timeoutMs); bus.once('change', () => { clearTimeout(timer); resolve(); }); });
      return { cursor, jobs: [...jobs.values()].map(job => ({ ...job })) };
    },
    touch: () => bump(),
    finish: (jobId, fields = {}) => { Object.assign(jobs.get(jobId), { status: 'completed', result: 'done: ' + jobId, finishedAt: new Date().toISOString(), ...fields }); bump(); },
    ...extra,
  };
  return backend;
}
function makeHub(name) {
  const backends = { codex: fakeBackend('codex'), dsh: fakeBackend('dsh') };
  const hub = createHub({ state: path.join(temp, name), backends, timing: { retryMs: 50, pollMs: 2000 } });
  const call = (method, params = {}) => hub.methods[method]({ owner: 'session-a', ...params });
  return { hub, backends, call };
}
const until = async (check, ms = 3000) => { for (let i = 0; i < ms / 20 && !await check(); i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(await check()); };

test('each session saves its own settings; a new one starts from the last saved values', async t => {
  const { hub, call } = makeHub('config'); t.after(() => hub.close());
  await assert.rejects(call('start', { backend: 'codex', tasks: [{ prompt: 'hi', requestId: 'r1' }] }), { code: 'config/required' });
  const state = await call('state', { cwd: 'C:/elsewhere' });
  assert.deepEqual(state.config.codex.values, { project: 'p1', workspace: temp }, 'Codex starts from the project its app has selected');
  assert.deepEqual(state.config.dsh.values, { mode: 'headless', workspace: temp, permission: 'danger-full-access' }, 'DSH starts from the bridge defaults');
  await assert.rejects(call('saveConfig', { backend: 'codex', values: { workspace: path.join(temp, 'missing') } }), { code: 'config/invalid' });
  await assert.rejects(call('saveConfig', { backend: 'codex', values: { project: 'nope', workspace: temp } }), { code: 'config/invalid' });
  const saved = await call('saveConfig', { backend: 'codex', values: { project: 'p2', workspace: 'stale', effort: 'low' } });
  assert.equal(saved.config.codex.status, 'ready');
  assert.equal(saved.config.codex.values.workspace, path.join(temp, 'beta'), 'a project means its root folder');
  const other = await hub.methods.state({ owner: 'session-b' });
  assert.equal(other.config.codex.status, 'draft');
  assert.equal(other.config.codex.values.effort, 'low');
});

test('dispatches carry the session\'s settings, and the mirror follows what the bridge reports', async t => {
  const { hub, backends, call } = makeHub('run'); t.after(() => hub.close());
  await call('saveConfig', { backend: 'dsh', values: { mode: 'desktop', workspace: temp, preset: 'unity', model: { provider: 'p', model: 'm' } } });
  const { jobs } = await call('start', { backend: 'dsh', tasks: [{ prompt: 'one', requestId: 'r1', title: 'One' }, { prompt: 'two', requestId: 'r2' }] });
  assert.equal(jobs.length, 2);
  assert.deepEqual(backends.dsh.calls[0].slice(1, 3), ['session-a', { mode: 'desktop', workspace: temp, preset: 'unity', model: { provider: 'p', model: 'm' } }]);
  assert.deepEqual((await hub.methods.state({ owner: 'session-b' })).subagents, [], 'another session sees none of them');
  const waiting = call('wait', { jobIds: [jobs[0].jobId], timeoutMs: 3000 });
  backends.dsh.finish(jobs[0].jobId);
  const waited = await waiting;
  assert.equal(waited.jobs[0].status, 'completed');
  assert.equal(waited.jobs[0].result, 'done: ' + jobs[0].jobId);
  const full = await call('result', { jobId: jobs[0].jobId });
  assert.equal(full.prompt, 'the whole prompt', 'result reads the whole record from the bridge');
  backends.dsh.finish(jobs[1].jobId);
  await until(async () => (await call('state')).subagents.every(agent => agent.status === 'completed'));
  assert.deepEqual((await call('notify')).jobs.map(job => job.jobId), [jobs[1].jobId], 'only the job nobody read wakes the session');
  assert.deepEqual((await call('notify')).jobs, [], 'and only once');
  await call('saveConfig', { wake: false });
  assert.equal((await call('state')).wake, false);
});

test('a bare wait returns jobs that ended before anyone read them', async t => {
  const { hub, backends, call } = makeHub('unread'); t.after(() => hub.close());
  await call('saveConfig', { backend: 'codex', values: { workspace: temp } });
  const { jobs } = await call('start', { backend: 'codex', tasks: [{ prompt: 'quick', requestId: 'q1' }] });
  backends.codex.finish(jobs[0].jobId);
  await until(async () => (await call('state')).subagents[0].status === 'completed');
  assert.deepEqual((await call('wait', { timeoutMs: 0 })).jobs.map(job => job.jobId), [jobs[0].jobId]);
  assert.equal((await call('wait', { timeoutMs: 0 })).reason, 'no-active-jobs');
});

test('resume, open and cancel follow each backend\'s rules', async t => {
  const { hub, backends, call } = makeHub('rules'); t.after(() => hub.close());
  await assert.rejects(call('resume', { backend: 'dsh', sessionId: 's', prompt: 'more', requestId: 'd1' }), /original mode/);
  const saved = await call('saveConfig', { backend: 'codex', values: { mode: 'desktop', workspace: temp } });
  assert.deepEqual(saved.config.codex.values, { workspace: temp }, 'Codex runs are always hidden: a stale mode is dropped');
  const resumed = await call('resume', { backend: 'codex', sessionId: 'thread-1', prompt: 'more', requestId: 'c1' });
  assert.equal('mode' in backends.codex.calls.at(-1)[2], false, 'a Codex resume carries no mode');
  await assert.rejects(call('open', { jobId: resumed.jobId }), { code: 'hub/open' }, 'never open a thread a run still writes');
  await call('cancel', { jobId: resumed.jobId });
  assert.equal((await call('state')).subagents[0].status, 'cancelled');
  await call('open', { jobId: resumed.jobId });
  assert.deepEqual(backends.codex.calls.at(-1), ['open', { jobId: resumed.jobId, sessionId: 'thread-1' }]);
  const headless = await call('resume', { backend: 'dsh', sessionId: 'dsh-s', mode: 'headless', prompt: 'x', requestId: 'd2' });
  await assert.rejects(call('open', { jobId: headless.jobId }), /isolated storage/);
});

test('a Host that stops answering is reported while its jobs run, and the mirror keeps them', async t => {
  const { hub, backends, call } = makeHub('offline'); t.after(() => hub.close());
  await call('saveConfig', { backend: 'dsh', values: { mode: 'headless', workspace: temp } });
  const { jobs } = await call('start', { backend: 'dsh', tasks: [{ prompt: 'x', requestId: 'o1' }] });
  backends.dsh.offline = true;
  backends.dsh.touch();
  await until(async () => (await call('state')).dshError === 'Host is not running');
  backends.dsh.offline = false;
  backends.dsh.finish(jobs[0].jobId);
  await until(async () => (await call('state')).subagents[0].status === 'completed');
  assert.equal((await call('state')).dshError, undefined);
});

test('jobs from before the bridges are dropped, settings are kept', async t => {
  const state = path.join(temp, 'migrate');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify({ schemaVersion: 1, sessions: { 'session-a': { config: { codex: { status: 'ready', revision: 1, values: { mode: 'desktop', workspace: temp } } }, delivered: {}, notified: {}, createdAt: new Date().toISOString() } }, lastConfig: { codex: { mode: 'desktop', workspace: temp } }, jobs: [{ jobId: 'codex-old', owner: 'session-a', backend: 'codex', status: 'completed', createdAt: new Date().toISOString() }] }));
  const hub = createHub({ state, backends: { codex: fakeBackend('codex'), dsh: fakeBackend('dsh') } }); t.after(() => hub.close());
  const after = await hub.methods.state({ owner: 'session-a' });
  assert.equal(after.config.codex.status, 'ready');
  assert.deepEqual(after.config.codex.values, { workspace: temp }, 'the old Codex mode is dropped');
  assert.deepEqual((await hub.methods.state({ owner: 'session-b' })).config.codex.values, { workspace: temp });
  assert.deepEqual(after.subagents, []);
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
