import type { EngineInterface, HttpInit, HttpResponse, ProcessRunInit, ProcessRunResult, UiOpenResult } from 'claude-code'

import type { Backend, Catalog, Catalogs, Connection, Draft, HubState, LoadState, Notice, View } from '../types'

export type Cells = { connection: Connection | null; snapshot: HubState | null; load: LoadState; view: View; draft: Draft; catalogs: Catalogs; notice: Notice | null; results: Record<string, string> }
// The engine interface may only be spelled $.noun.method(...) where it is used,
// so the hooks hand helpers this set of closures instead of $ itself.
export type Io = {
  root: string
  sessionId: () => Promise<string>
  cwd: () => Promise<string>
  fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  get: <K extends keyof Cells>(key: K) => Promise<Cells[K]>
  set: <K extends keyof Cells>(key: K, fn: (value: Cells[K]) => Cells[K]) => Promise<unknown>
  open: (tab?: 'tasks' | 'config') => Promise<UiOpenResult>
  toast: (text: string) => void
  submit: (text: string) => Promise<unknown>
  after: (ms: number, fn: () => void) => void
  every: (ms: number, fn: () => void) => void
}

export class HubError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

let owner: string | undefined
export async function ownerOf(io: Io): Promise<string> {
  owner ??= await io.sessionId()
  return owner
}

// Starts the daemon when asked to; a poll only talks to one that already runs,
// so opening a session never spawns anything by itself.
async function connect(io: Io, start: boolean): Promise<Connection | null> {
  const known = await io.get('connection')
  if (known) return known
  if (!start) return null
  const ran = await io.run(['node', io.root + '/daemon/launch.mjs', '--upgrade'], { timeoutMs: 20000 })
  if (ran.exitCode !== 0) throw new HubError('hub/launch', ran.stderr.trim() || 'The agent hub daemon did not start')
  const found = JSON.parse(ran.stdout.trim()) as Connection
  await io.set('connection', () => found)
  return found
}

export async function call<T = unknown>(io: Io, method: string, params: Record<string, unknown> = {}, { start = true } = {}): Promise<T> {
  const body = JSON.stringify({ method, params: { owner: await ownerOf(io), ...params } })
  for (let attempt = 0; attempt < 2; attempt++) {
    const hub = await connect(io, start)
    if (!hub) throw new HubError('hub/offline', 'The agent hub is not running')
    let text: string
    try {
      const response = await io.fetch(hub.url + '/api', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + hub.token, 'content-type': 'application/json' },
        body,
      })
      text = response.text
    } catch (error) {
      // The daemon restarted on another port or exited: forget it and relaunch once.
      await io.set('connection', () => null)
      if (attempt === 0 && start) continue
      throw new HubError('hub/offline', 'The agent hub is not reachable: ' + String((error as Error).message ?? error))
    }
    const reply = JSON.parse(text) as { result?: T; error?: { code: string; message: string } }
    if (reply.error) {
      if (reply.error.message === 'Unauthorized' && attempt === 0) {
        await io.set('connection', () => null)
        continue
      }
      throw new HubError(reply.error.code, reply.error.message)
    }
    return reply.result as T
  }
  throw new HubError('hub/offline', 'The agent hub is not reachable')
}

export async function refresh(io: Io, { start = false } = {}): Promise<HubState | null> {
  try {
    const state = await call<HubState>(io, 'state', { cwd: await io.cwd() }, { start })
    await io.set('snapshot', () => state)
    await io.set('load', () => ({ at: Date.now() }))
    return state
  } catch (error) {
    if ((error as HubError).code !== 'hub/offline' || start) await io.set('load', () => ({ error: (error as Error).message, at: Date.now() }))
    return null
  }
}

export async function loadCatalog(io: Io, backend: Backend, force = false): Promise<void> {
  const known = await io.get('catalogs')
  if (!force && (known[backend] || known.loading === backend)) return
  await io.set('catalogs', value => ({ ...value, loading: backend, error: undefined }))
  try {
    const found = await call<Catalog>(io, 'catalog', { backend, refresh: force })
    await io.set('catalogs', value => ({ ...value, [backend]: found, loading: undefined }))
  } catch (error) {
    await io.set('catalogs', value => ({ ...value, loading: undefined, error: (error as Error).message }))
  }
}
