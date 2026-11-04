// Prints {url, token} of a running hub, starting one first if needed.
// The Claude pane runs this; it exits as soon as the hub answers.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, STATE, VERSION, readJson } from './common.mjs';

async function probe() {
  const info = readJson(path.join(STATE, 'hub.json'), null);
  if (!info?.url) return null;
  try {
    const response = await fetch(info.url + '/api', { method: 'POST', headers: { authorization: 'Bearer ' + info.token, 'content-type': 'application/json' },
      body: '{"method":"health"}', signal: AbortSignal.timeout(1500) });
    const reply = await response.json();
    if (reply.result?.instanceId === info.instanceId) return { ...info, running: reply.result.version };
  } catch {}
  return null;
}

// Numeric x.y.z compare; anything unparsable counts as older.
const older = (a, b) => {
  const parse = value => String(value ?? '').split('.').map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) { if (!((x[i] ?? 0) >= 0)) return true; if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); }
  return false;
};

let info = await probe();
// A hub from an older plugin version is replaced: running work lives in the bridges
// and the mirror is on disk, so nothing is lost. Never a newer one, so a session
// still on an old plugin cannot take the hub back.
if (info && older(info.running, VERSION) && process.argv.includes('--upgrade')) {
  try { process.kill(info.pid); } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
  info = null;
}
if (!info) {
  fs.mkdirSync(path.join(STATE, 'logs'), { recursive: true });
  const log = fs.openSync(path.join(STATE, 'logs', 'hub.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'daemon/hub.mjs')], { detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  child.unref(); fs.closeSync(log);
  for (let i = 0; i < 60 && !info; i++) { await new Promise(resolve => setTimeout(resolve, 100)); info = await probe(); }
}
if (!info) { console.error('agent hub did not start; see ' + path.join(STATE, 'logs', 'hub.log')); process.exit(1); }
console.log(JSON.stringify({ url: info.url, token: info.token, version: info.running }));
