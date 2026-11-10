import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { STATE, VERSION, BACKENDS, MODES, HubError, atomic, readJson, now, summary, terminal, owner } from './common.mjs';
import { codexBridge, dshBridge } from './bridges.mjs';

const RETAIN_DAYS = 30, RETAIN_PER_OWNER = 200;
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];

// The hub is Agent Hub's own layer: per-session settings, which Claude session
// owns which job, what the model has read, and the pane's data. Running work is
// the bridges' (Common/dsh-bridge, Common/codex-bridge); the hub mirrors the jobs
// they report, so the pane keeps ended jobs after a DSH Host has gone.
export function createHub({ state = STATE, backends = { codex: codexBridge(), dsh: dshBridge() }, clock = Date.now, timing = { retryMs: 3000, pollMs: 25000 } } = {}) {
  const file = path.join(state, 'state.json');
  const stored = readJson(file, {});
  // Jobs from before the bridges (schema 1) are dropped; settings are kept.
  const data = { schemaVersion: 2, sessions: stored.sessions ?? {}, lastConfig: stored.lastConfig ?? {}, mirror: stored.schemaVersion === 2 ? stored.mirror ?? {} : {} };
  // Codex runs are always hidden now (codex-bridge protocol 2): drop the old mode.
  for (const values of [data.lastConfig.codex, ...Object.values(data.sessions).map(entry => entry.config?.codex?.values)]) if (values) delete values.mode;
  for (const job of Object.values(data.mirror)) if (job.backend === 'codex') { delete job.mode; delete job.appOpen; }
  const changes = new EventEmitter(); changes.setMaxListeners(100);
  let cursor = 0, saveTimer, closed = false;
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => atomic(file, data), 50); };
  const changed = () => { cursor++; save(); changes.emit('change'); };

  const session = id => (data.sessions[id] ??= { config: {}, delivered: {}, notified: {}, createdAt: now() });
  const backendOf = backend => { if (!BACKENDS.includes(backend)) throw new HubError('hub/backend', 'backend must be dsh or codex'); return backend; };

  // ---------- settings ----------

  const catalogs = new Map(); // backend -> {at, value}
  async function catalog(backend, { refresh = false, mode } = {}) {
    const cached = catalogs.get(backend);
    if (cached && !refresh && clock() - cached.at < 600000) return cached.value;
    const value = await backends[backend].catalog({ mode });
    catalogs.set(backend, { at: clock(), value });
    return value;
  }
  async function defaults(backend, cwd) {
    if (data.lastConfig[backend]) return structuredClone(data.lastConfig[backend]);
    if (backend === 'codex') {
      // A Codex task belongs to one of the Codex app's projects; start from the one it has selected.
      try {
        const { projects = [], defaults: chosen = {} } = await catalog('codex');
        const project = projects.find(item => item.id === chosen.project);
        if (project) return { project: project.id, workspace: project.root };
      } catch {}
      return { workspace: cwd || process.cwd() };
    }
    let bridge = {};
    try { bridge = await backends.dsh.defaults(); } catch {}
    return { mode: 'headless', workspace: bridge.workspace || cwd || process.cwd(), ...(bridge.permission ? { permission: bridge.permission } : {}) };
  }
  const configOf = async (id, backend, cwd) => session(id).config[backend] ?? { status: 'draft', revision: 0, values: await defaults(backend, cwd) };

  async function validate(backend, input) {
    const text = (key, value) => { if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new HubError('config/invalid', 'Invalid ' + key); return value?.trim(); };
    if (typeof input !== 'object' || !input) throw new HubError('config/invalid', 'values are required');
    if (backend === 'dsh' && !MODES.includes(input.mode)) throw new HubError('config/invalid', 'mode must be desktop or headless');
    let workspace = text('workspace', input.workspace);
    if (backend === 'codex' && input.project !== undefined) {
      const project = (await catalog('codex')).projects?.find(item => item.id === input.project);
      if (!project) throw new HubError('config/invalid', 'Unknown Codex project ' + input.project);
      workspace = project.root;
    }
    if (!workspace) throw new HubError('config/invalid', 'workspace is required');
    if (!fs.existsSync(workspace)) throw new HubError('config/invalid', 'workspace does not exist: ' + workspace);
    if (backend === 'codex') {
      const value = { workspace, ...(input.project !== undefined ? { project: input.project } : {}) };
      for (const key of ['model', 'effort', 'sandbox']) if (input[key]) value[key] = text(key, input[key]);
      if (value.sandbox && !SANDBOXES.includes(value.sandbox)) throw new HubError('config/invalid', 'Unknown sandbox ' + value.sandbox);
      // `mode` may linger in a form opened before Codex runs became always hidden: drop it.
      for (const key of Object.keys(input)) if (!['mode', 'workspace', 'project', 'model', 'effort', 'sandbox'].includes(key)) throw new HubError('config/invalid', 'Unknown Codex setting ' + key);
      return value;
    }
    const value = { mode: input.mode, workspace };
    for (const key of ['preset', 'permission']) if (input[key]) value[key] = text(key, input[key]);
    if (input.model?.model) {
      if (!input.model.provider) throw new HubError('config/invalid', 'DSH model needs its provider');
      value.model = { provider: text('provider', input.model.provider), model: text('model', input.model.model), ...(input.model.reasoningEffort ? { reasoningEffort: text('reasoningEffort', input.model.reasoningEffort) } : {}) };
    }
    for (const key of Object.keys(input)) if (!['mode', 'workspace', 'preset', 'permission', 'model'].includes(key)) throw new HubError('config/invalid', 'Unknown DSH setting ' + key);
    return value;
  }
  function readyConfig(id, backend) {
    const entry = session(id).config[backend];
    if (entry?.status !== 'ready') throw new HubError('config/required', `Save this session's ${backend.toUpperCase()} configuration in the Agent Hub pane before the first dispatch`);
    return entry.values;
  }

  // ---------- jobs: a mirror of what the bridges report ----------

  const streamOf = job => job.backend === 'dsh' ? 'dsh:' + job.mode : 'codex';
  const offline = {}; // stream -> reason
  const watching = new Set();
  const kicked = new Set(); // streams just dispatched to, watched until their first report
  function remember(job) {
    if (!job?.jobId || !job.owner) return false;
    const previous = data.mirror[job.jobId];
    const next = { ...previous, ...job };
    if (JSON.stringify(previous) === JSON.stringify(next)) return false;
    data.mirror[job.jobId] = next;
    return true;
  }
  // One long poll per stream (Codex, DSH desktop, DSH headless) while it has
  // running jobs. A DSH Host that is not running is reported, never started.
  function watch(stream) {
    if (watching.has(stream) || closed) return;
    watching.add(stream);
    void (async () => {
      let streamCursor;
      const [backend, mode] = stream.split(':');
      while (!closed) {
        const active = Object.values(data.mirror).some(job => streamOf(job) === stream && !terminal(job.status));
        if (!active && !kicked.has(stream)) break;
        try {
          const reply = await backends[backend].events({ mode, cursor: streamCursor, timeoutMs: timing.pollMs });
          streamCursor = reply.cursor;
          kicked.delete(stream);
          let updated = offline[stream] !== undefined;
          delete offline[stream];
          for (const job of reply.jobs) if (remember(job)) updated = true;
          if (updated) changed();
        } catch (error) {
          if (offline[stream] !== error.message) { offline[stream] = error.message; changed(); }
          await new Promise(resolve => setTimeout(resolve, timing.retryMs));
        }
      }
      watching.delete(stream);
    })();
  }
  const kick = stream => { kicked.add(stream); watch(stream); };
  for (const job of Object.values(data.mirror)) if (!terminal(job.status)) watch(streamOf(job));

  const ownedJobs = id => Object.values(data.mirror).filter(job => job.owner === id);
  function locate(id, jobId) {
    const job = data.mirror[jobId];
    if (!job || job.owner !== id) throw new HubError('hub/job', 'Unknown jobId in this Claude session');
    return job;
  }
  const compact = (job, { full = false } = {}) => {
    const { prompt, owner: _, activity = [], ...rest } = job;
    return { ...rest, activity: full ? activity : activity.slice(-6), ...(full ? (prompt ? { prompt } : {}) : { result: job.result === undefined ? undefined : summary(job.result, 400) }) };
  };
  function group(list) {
    const groups = new Map();
    for (const job of [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const key = job.backend + ':' + (job.sessionId || job.jobId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(job);
    }
    return [...groups].map(([key, turns]) => {
      const latest = turns.findLast(turn => !terminal(turn.status)) || turns.at(-1);
      return { key, ...compact(latest), title: turns[0].title || latest.title, firstCreatedAt: turns[0].createdAt,
        turns: turns.map(turn => ({ jobId: turn.jobId, status: turn.status, createdAt: turn.createdAt, finishedAt: turn.finishedAt, promptSummary: turn.promptSummary })) };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const deliver = (id, list) => { const marks = session(id).delivered; for (const job of list) if (terminal(job.status)) marks[job.jobId] ??= now(); save(); };
  const waitChange = ms => new Promise(resolve => { const done = () => { clearTimeout(timer); changes.off('change', done); resolve(); }; const timer = setTimeout(done, ms); changes.once('change', done); });
  const checkTask = task => {
    if (typeof task.prompt !== 'string' || !task.prompt.trim()) throw new HubError('hub/tasks', 'Every task needs a prompt');
    if (typeof task.requestId !== 'string' || !task.requestId.trim()) throw new HubError('hub/tasks', 'Every task needs a requestId');
  };
  const streamOffline = (backend, mode) => offline[backend === 'dsh' ? 'dsh:' + mode : 'codex'];

  const methods = {
    health: async () => ({ version: VERSION, pid: process.pid }),
    state: async params => {
      const id = owner(params);
      const entry = session(id);
      const config = {};
      for (const backend of BACKENDS) config[backend] = await configOf(id, backend, params.cwd);
      const list = ownedJobs(id);
      const problems = [...new Set(list.filter(job => !terminal(job.status)).map(job => streamOffline(job.backend, job.mode)).filter(Boolean))];
      return { owner: id, cursor, version: VERSION, wake: entry.wake !== false, config, ...(problems.length ? { dshError: problems.join('; ') } : {}), subagents: group(list) };
    },
    saveConfig: async params => {
      const id = owner(params);
      const entry = session(id);
      if (params.wake !== undefined) entry.wake = params.wake === true;
      if (params.backend !== undefined) {
        const backend = backendOf(params.backend);
        const previous = entry.config[backend];
        const values = await validate(backend, params.values);
        entry.config[backend] = { status: 'ready', revision: (previous?.revision ?? 0) + 1, savedAt: now(), values };
        data.lastConfig[backend] = values;
      }
      changed();
      const config = {};
      for (const backend of BACKENDS) config[backend] = await configOf(id, backend);
      return { config, wake: entry.wake !== false };
    },
    catalog: async params => { owner(params); return catalog(backendOf(params.backend), { refresh: params.refresh, mode: params.mode }); },
    sessions: async params => {
      owner(params);
      const { owner: _, backend, ...rest } = params;
      return backends[backendOf(backend)].sessions(rest);
    },
    start: async params => {
      const id = owner(params);
      const backend = backendOf(params.backend);
      const values = readyConfig(id, backend);
      const tasks = params.tasks;
      if (!Array.isArray(tasks) || !tasks.length || tasks.length > 16) throw new HubError('hub/tasks', 'Provide 1 to 16 tasks');
      tasks.forEach(checkTask);
      if (new Set(tasks.map(task => task.requestId)).size !== tasks.length) throw new HubError('hub/tasks', 'Every task needs a distinct requestId');
      const settings = { ...values }; delete settings.project;
      const settled = await Promise.allSettled(tasks.map(task => backends[backend].start(id, settings, task)));
      const jobs = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      const errors = settled.flatMap((result, index) => result.status === 'rejected' ? [{ requestId: tasks[index].requestId, message: result.reason.message }] : []);
      for (const job of jobs) remember(job);
      kick(backend === 'dsh' ? 'dsh:' + values.mode : 'codex');
      changed();
      if (!jobs.length && errors.length) throw new HubError('hub/start', errors.map(error => error.message).join('; '));
      return { jobs: jobs.map(job => compact(job)), errors };
    },
    resume: async params => {
      const id = owner(params);
      const backend = backendOf(params.backend);
      checkTask(params);
      if (typeof params.sessionId !== 'string' || !params.sessionId.trim()) throw new HubError('hub/resume', 'sessionId is required');
      if (backend === 'dsh' && !MODES.includes(params.mode)) throw new HubError('hub/resume', 'DSH resume needs the session\'s original mode (desktop or headless)');
      const job = await backends[backend].resume(id, { sessionId: params.sessionId, ...(backend === 'dsh' ? { mode: params.mode } : {}), prompt: params.prompt, requestId: params.requestId, title: params.title });
      remember(job);
      kick(backend === 'dsh' ? 'dsh:' + params.mode : 'codex');
      changed();
      return compact(job);
    },
    wait: async params => {
      const id = owner(params);
      const deadline = clock() + Math.max(0, Math.min(params.timeoutMs ?? 45000, 50000));
      let ids = params.jobIds;
      // By default: what still runs, plus what ended before the model read it.
      const delivered = session(id).delivered;
      if (!ids?.length) ids = ownedJobs(id).filter(job => !terminal(job.status) || !delivered[job.jobId]).map(job => job.jobId);
      if (!ids.length) return { reason: 'no-active-jobs', jobs: [] };
      for (const jobId of ids) locate(id, jobId);
      const ready = () => ids.some(jobId => { const job = data.mirror[jobId]; return terminal(job.status) || job.status === 'waiting'; });
      while (!ready() && clock() < deadline) await waitChange(deadline - clock());
      const list = ids.map(jobId => data.mirror[jobId]);
      deliver(id, list);
      return { reason: ready() ? 'attention-or-completion' : 'timeout', jobs: list.map(job => terminal(job.status) ? { ...compact(job), result: job.result } : compact(job)) };
    },
    result: async params => {
      const id = owner(params);
      let job = locate(id, params.jobId);
      // The bridge has the whole record (prompt, every action); the mirror is enough when it is gone.
      try { const fresh = await backends[job.backend].status(job.jobId, job.mode); if (remember(fresh)) changed(); job = { ...data.mirror[job.jobId], ...fresh }; } catch {}
      deliver(id, [job]);
      return compact(job, { full: true });
    },
    cancel: async params => {
      const id = owner(params);
      const job = locate(id, params.jobId);
      if (terminal(job.status)) return compact(job);
      const reply = await backends[job.backend].cancel(job.jobId, job.mode);
      if (remember(reply)) changed();
      return compact(data.mirror[job.jobId]);
    },
    // Adds a message to a job's running turn. Only Codex takes one mid-turn.
    steer: async params => {
      const id = owner(params);
      const job = locate(id, params.jobId);
      if (typeof params.prompt !== 'string' || !params.prompt.trim()) throw new HubError('hub/steer', 'prompt is required');
      if (!backends[job.backend].steer) throw new HubError('hub/steer', 'Only Codex jobs take a message mid-turn; wait for this job to end and resume its session');
      if (terminal(job.status)) throw new HubError('hub/steer', 'This job has ended; resume its session instead');
      const reply = await backends[job.backend].steer(job.jobId, params.prompt);
      if (remember(reply)) changed();
      return compact(data.mirror[job.jobId]);
    },
    open: async params => {
      const id = owner(params);
      const job = params.jobId ? locate(id, params.jobId) : null;
      const backend = job?.backend ?? backendOf(params.backend);
      const sessionId = job?.sessionId ?? params.sessionId;
      if (!sessionId) throw new HubError('hub/open', 'This task has no session yet');
      if (backend === 'dsh' && (job?.mode ?? params.mode) === 'headless') throw new HubError('hub/open', 'Headless DSH sessions use isolated storage and cannot be opened in DSH Desktop');
      if (backend === 'codex' && job && !terminal(job.status)) throw new HubError('hub/open', 'The Codex app cannot load a thread while its run writes it; open it when the run ends');
      return backends[backend].open({ jobId: job?.jobId, sessionId });
    },
    // Ended jobs the model has not read yet, each returned once: the pane wakes the
    // session with them, and a second pane or a reload never wakes it twice.
    notify: async params => {
      const id = owner(params);
      const entry = session(id);
      if (entry.wake === false) return { jobs: [] };
      const due = ownedJobs(id).filter(job => terminal(job.status) && !entry.delivered[job.jobId] && !entry.notified[job.jobId]
        && Date.parse(job.finishedAt ?? job.createdAt) >= Date.parse(entry.createdAt));
      for (const job of due) entry.notified[job.jobId] = now();
      if (due.length) save();
      return { jobs: due.map(job => ({ jobId: job.jobId, backend: job.backend, title: job.title, status: job.status })) };
    },
  };

  function cleanup() {
    const cutoff = clock() - RETAIN_DAYS * 86400000;
    const counts = new Map();
    for (const job of Object.values(data.mirror).sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      if (!terminal(job.status)) continue;
      const count = (counts.get(job.owner) ?? 0) + 1; counts.set(job.owner, count);
      if (Date.parse(job.finishedAt ?? job.createdAt) < cutoff || count > RETAIN_PER_OWNER) delete data.mirror[job.jobId];
    }
    for (const [id, entry] of Object.entries(data.sessions)) {
      if (!ownedJobs(id).length && Date.parse(entry.createdAt) < cutoff) delete data.sessions[id];
    }
    save();
  }
  const sweeper = setInterval(cleanup, 3600000);
  cleanup();
  return {
    methods,
    get cursor() { return cursor; },
    active: () => Object.values(data.mirror).some(job => !terminal(job.status)),
    close() { closed = true; clearInterval(sweeper); clearTimeout(saveTimer); atomic(file, data); },
  };
}

export async function serve({ state = STATE } = {}) {
  fs.mkdirSync(state, { recursive: true });
  const lock = net.createServer();
  const pipe = '\\\\.\\pipe\\claude-agent-hub-' + createHash('sha256').update(path.resolve(state).toLowerCase()).digest('hex').slice(0, 16);
  try { await new Promise((resolve, reject) => { lock.once('error', reject); lock.listen(pipe, resolve); }); }
  catch { return null; }
  const infoFile = path.join(state, 'hub.json');
  const previous = readJson(infoFile, {});
  const token = previous.token || randomBytes(24).toString('hex');
  const hub = createHub({ state });
  const instanceId = randomUUID();
  let baseUrl, lastCall = Date.now();
  const authorized = header => {
    const expected = Buffer.from('Bearer ' + token);
    const given = Buffer.from(String(header ?? ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    if (request.headers.host !== new URL(baseUrl).host) { response.writeHead(403); return response.end('{"error":{"message":"Forbidden host"}}'); }
    if (request.headers.origin) { response.writeHead(403); return response.end('{"error":{"message":"Browser requests are not accepted"}}'); }
    if (!authorized(request.headers.authorization)) { response.writeHead(401); return response.end('{"error":{"message":"Unauthorized"}}'); }
    if (request.url !== '/api' || request.method !== 'POST') { response.writeHead(404); return response.end('{"error":{"message":"Not found"}}'); }
    try {
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 2 * 1024 * 1024) throw new HubError('hub/size', 'Request too large'); }
      const call = JSON.parse(body);
      if (!Object.hasOwn(hub.methods, call.method)) throw new HubError('hub/method', 'Unknown method ' + call.method);
      lastCall = Date.now();
      const result = call.method === 'health' ? { ...await hub.methods.health(), instanceId } : await hub.methods[call.method](call.params ?? {});
      response.end(JSON.stringify({ result }));
    } catch (error) {
      response.end(JSON.stringify({ error: { code: error.code ?? 'hub/error', message: error.message } }));
    }
  });
  const listen = port => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  try { await listen(Number(previous.url ? new URL(previous.url).port : 0)); } catch { await listen(0); }
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  atomic(infoFile, { url: baseUrl, token, pid: process.pid, instanceId, version: VERSION, startedAt: now() });
  // Nothing to do for a day and nothing running: let the next session start a fresh one.
  setInterval(() => { if (!hub.active() && Date.now() - lastCall > 86400000) { hub.close(); process.exit(0); } }, 600000).unref();
  console.error('agent hub ready at ' + baseUrl);
  return { url: baseUrl, hub, server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const started = await serve();
  if (!started) process.exit(0);
}
