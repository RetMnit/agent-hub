import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8')).version;
// Under ~/.claude, not %LOCALAPPDATA%: the desktop app is packaged and sees a private
// AppData, which a terminal session of Claude Code would not share.
export const STATE = process.env.AGENT_HUB_STATE_DIR || path.join(os.homedir(), '.claude', 'agent-hub');

export const BACKENDS = ['dsh', 'codex'];
export const MODES = ['desktop', 'headless'];
export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
export const terminal = status => TERMINAL.has(status);

export const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (fallback !== undefined && error.code === 'ENOENT') return fallback; throw error; }
};
export function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
export const now = () => new Date().toISOString();
export const summary = (text, length = 80) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > length ? flat.slice(0, length - 1) + '…' : flat;
};
export const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
export class HubError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
// Claude session IDs are UUIDs; reject anything that could escape a path or a scope.
export function owner(params) {
  const id = params?.owner;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(id)) throw new HubError('hub/owner', 'owner must be the Claude session ID');
  return id;
}
