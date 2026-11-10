// Agent Hub drives both backends through the shared bridges in Common/ (dsh-bridge,
// codex-bridge), loading each one's installed runtime by its install.json. Both
// adapters answer in one shape, so the hub never branches on the backend for jobs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { HubError, readJson, summary, terminal } from './common.mjs';

export const CLIENT = 'agent-hub';
const DSH_STATE = process.env.DSH_BRIDGE_STATE_DIR || path.join(os.homedir(), '.dsh-bridge');
const CODEX_STATE = process.env.CODEX_BRIDGE_STATE_DIR || path.join(os.homedir(), '.codex-bridge');

async function load(state, name) {
  const install = readJson(path.join(state, 'install.json'), null);
  if (!install?.root || !fs.existsSync(install.root)) throw new HubError(name + '/not-installed', `The ${name} bridge is not installed: run "node setup.mjs" in Common/${name}-bridge`);
  return import(pathToFileURL(path.join(install.root, 'lib/client.mjs')).href);
}
// One Claude session owns a job: its requestId is "<session>:<requestId>".
const scoped = (owner, requestId) => owner + ':' + requestId;
const ownerOf = requestId => requestId?.slice(0, requestId.indexOf(':'));
const plainRequest = requestId => requestId?.slice(requestId.indexOf(':') + 1);
const pick = (values, keys) => Object.fromEntries(keys.filter(key => values[key] !== undefined).map(key => [key, values[key]]));

// ---------- Codex ----------

export function codexBridge({ state = CODEX_STATE, connect } = {}) {
  let bridge;
  const call = async (method, params = {}) => {
    connect ??= (await load(state, 'codex')).connect;
    bridge ??= await connect({ state });
    try { return await bridge.call(method, { client: CLIENT, ...params }); }
    catch (error) { if (error.code === 'bridge/offline' || error.cause) bridge = undefined; throw error; }
  };
  const unify = job => ({ ...job, backend: 'codex', owner: ownerOf(job.requestId), requestId: plainRequest(job.requestId) });
  return {
    name: 'codex',
    catalog: () => call('catalog'),
    sessions: params => call('sessions', params),
    // Runs are always hidden (protocol 2); the app shows a thread only through open.
    start: async (owner, values, task) => unify(await call('start', { ...pick(values, ['workspace', 'model', 'effort', 'sandbox']), prompt: task.prompt, requestId: scoped(owner, task.requestId), ...(task.title ? { title: task.title } : {}) })),
    // The thread keeps its own folder, model, effort and sandbox.
    resume: async (owner, task) => unify(await call('resume', { sessionId: task.sessionId, prompt: task.prompt, requestId: scoped(owner, task.requestId), ...(task.title ? { title: task.title } : {}) })),
    status: async jobId => unify(await call('status', { jobId })),
    cancel: async jobId => unify(await call('cancel', { jobId })),
    // A message for the turn that is running.
    steer: async (jobId, prompt) => unify(await call('steer', { jobId, prompt })),
    open: ({ jobId, sessionId }) => call('open', jobId ? { jobId } : { sessionId }),
    // Deletes threads Agent Hub started; the bridge drops its job records with them.
    delete: sessionIds => call('delete', { sessionIds }),
    // Every Agent Hub job, at once when anything changed after `cursor`.
    events: async ({ cursor, timeoutMs }) => {
      const reply = await call('events', { afterCursor: cursor, timeoutMs });
      return { cursor: reply.cursor, jobs: reply.jobs.map(unify) };
    },
  };
}

// ---------- DSH ----------

const STATUS = status => status?.startsWith('waiting-') ? 'waiting' : terminal(status) ? status : 'running';
function activity(events = []) {
  return events.flatMap(event => {
    if (event.type === 'tool/call') return [{ at: event.at, kind: 'tool', text: event.tool ?? '' }];
    if (event.type === 'assistant/message' && event.text) return [{ at: event.at, kind: 'message', text: summary(event.text, 160) }];
    return [];
  });
}
export function unifyDsh(job) {
  const settings = job.effective ?? job.requested ?? {};
  return {
    jobId: job.jobId, backend: 'dsh', owner: ownerOf(job.requestId), mode: job.mode, sessionId: job.sessionId, title: job.title, requestId: plainRequest(job.requestId),
    status: STATUS(job.status), phase: job.status?.startsWith('waiting-') ? job.status : job.phase,
    createdAt: job.createdAt, startedAt: job.createdAt, updatedAt: job.updatedAt, finishedAt: job.finishedAt,
    promptSummary: job.promptSummary, result: job.result, error: typeof job.error === 'object' ? job.error?.message : job.error, pendingQuestions: job.pendingQuestions,
    activity: activity(job.events).slice(-40), runningChildren: job.descendants?.filter(child => child.status === 'running').length || undefined,
    settings: { workspace: settings.workspace, preset: settings.preset, model: settings.model?.model, provider: settings.model?.provider, effort: settings.model?.reasoningEffort, permission: settings.permission },
    usage: job.usageSamples?.at(-1),
  };
}
export function dshBridge({ state = DSH_STATE, connect } = {}) {
  let client;
  const dsh = async () => {
    connect ??= (await load(state, 'dsh')).connect;
    return (client ??= connect({ state }));
  };
  const call = async (mode, method, params = {}, options) => (await dsh()).call(mode, method, { client: CLIENT, ...params }, options);
  const instances = {};
  return {
    name: 'dsh',
    defaults: async () => (await dsh()).defaults,
    // A new subagent's preset/model/permission menus: the hidden Host knows the same presets and providers as Desktop.
    catalog: async ({ mode = 'headless' } = {}) => {
      const raw = await call(mode, 'catalog');
      const presets = (raw.presets?.presets ?? []).map(preset => ({ id: preset.id, name: preset.name ?? preset.id, description: preset.description, isDefault: !!preset.isDefault }));
      return {
        presets,
        models: (raw.models?.groups ?? []).flatMap(group => (group.models ?? []).map(model => ({ provider: group.id, providerName: group.name, id: model.id, name: model.name ?? model.id,
          efforts: (model.reasoning?.efforts ?? []).map(effort => effort.id), defaultEffort: model.reasoning?.defaultEffort }))),
        permissions: (raw.permissions?.options ?? []).map(option => option.value),
        defaults: { preset: presets.find(preset => preset.isDefault)?.id, model: raw.models?.default?.model, provider: raw.models?.default?.provider, effort: raw.models?.default?.reasoningEffort, permission: raw.permissions?.defaultPreset },
      };
    },
    sessions: async ({ mode = 'desktop', ...params } = {}) => ({ sessions: await call(mode, 'sessions', params) }),
    start: async (owner, values, task) => {
      const { mode, ...settings } = values;
      return unifyDsh(await call(mode, 'start', { ...settings, prompt: task.prompt, requestId: scoped(owner, task.requestId), ...(task.title ? { title: task.title } : {}) }));
    },
    // The session keeps its own workspace, preset, model and permission.
    resume: async (owner, task) => unifyDsh(await call(task.mode, 'start', { sessionId: task.sessionId, prompt: task.prompt, requestId: scoped(owner, task.requestId), ...(task.title ? { title: task.title } : {}) })),
    status: async (jobId, mode) => unifyDsh(await call(mode, 'status', { jobId }, { start: false })),
    cancel: async (jobId, mode) => unifyDsh(await call(mode, 'cancel', { jobId }, { start: false })),
    open: async ({ jobId, sessionId }) => {
      const reply = await call('desktop', 'open', jobId ? { jobId } : { sessionId });
      (await dsh()).focusDesktop();
      return reply;
    },
    // Watching never starts a Host: a mode whose Host is not running reports offline.
    events: async ({ mode, cursor, timeoutMs }) => {
      const reply = await call(mode, 'events', { afterCursor: cursor, instanceId: instances[mode], timeoutMs }, { start: false });
      instances[mode] = reply.instanceId;
      return { cursor: reply.cursor, jobs: reply.jobs.map(unifyDsh) };
    },
  };
}
