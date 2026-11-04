export type Backend = 'dsh' | 'codex';
// DSH only: Codex runs are always hidden.
export type Mode = 'desktop' | 'headless';
export type JobStatus = 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export type Activity = { at?: string; kind: string; text: string; status?: string };
export type JobSettings = { workspace?: string; preset?: string; model?: string; provider?: string; effort?: string; permission?: string; sandbox?: string };
export type Turn = { jobId: string; status: JobStatus; createdAt: string; finishedAt?: string; promptSummary?: string };
export type Subagent = {
  key: string; jobId: string; backend: Backend; mode?: Mode; sessionId?: string; title?: string; status: JobStatus; phase?: string;
  createdAt: string; startedAt?: string; finishedAt?: string; promptSummary?: string; result?: string; error?: string;
  activity?: Activity[]; plan?: { text: string; done: boolean }[]; settings?: JobSettings; turns: Turn[];
};
export type ConfigValues = { mode?: Mode; workspace: string; project?: string; preset?: string; permission?: string; sandbox?: string; effort?: string; model?: string | { provider: string; model: string; reasoningEffort?: string } };
export type ConfigEntry = { status: 'draft' | 'ready'; revision: number; savedAt?: string; values: ConfigValues };
export type HubState = { owner: string; cursor: number; version: string; wake: boolean; config: Record<Backend, ConfigEntry>; dshError?: string; subagents: Subagent[] };

export type CatalogModel = { id: string; name: string; provider?: string; providerName?: string; efforts: string[]; defaultEffort?: string };
export type Catalog = { projects?: { id: string; name: string; root: string }[]; presets?: { id: string; name: string; description?: string; isDefault: boolean }[]; models: CatalogModel[]; permissions: string[]; defaults: Record<string, string | undefined> };

export type Connection = { url: string; token: string; version?: string };
export type View = { tab: 'tasks' | 'config'; backend: Backend; expanded?: string };
export type Draft = Partial<Record<Backend, ConfigValues>>;
export type Catalogs = { dsh?: Catalog; codex?: Catalog; loading?: Backend; error?: string };
export type Notice = { text: string; tone: 'success' | 'error' | 'info'; at: number };
export type LoadState = { error?: string; at?: number };

declare module 'claude-code' {
  interface PluginState {
    'agent-hub': {
      connection: Shaped<Connection | null>;
      snapshot: Shaped<HubState | null>;
      load: Shaped<LoadState>;
      view: Shaped<View>;
      draft: Shaped<Draft>;
      catalogs: Shaped<Catalogs>;
      notice: Shaped<Notice | null>;
      results: Shaped<Record<string, string>>;
    };
  }
}
