import type { Elements, EngineInterface, RenderElement } from 'claude-code'

import type { Backend, Catalog, Catalogs, ConfigValues, Draft, HubState, JobStatus, LoadState, Notice, Subagent, View } from '../types'
import { call, loadCatalog, refresh } from './hub'
import type { Io } from './hub'

type Table = ReturnType<EngineInterface['ui']['resolve']>
const DEFAULT = '__default__'
const CUSTOM = '__custom__'

const STATUS: Record<JobStatus, { glyph: string; label: string; color: string }> = {
  starting: { glyph: '◌', label: '启动中', color: 'claude' },
  running: { glyph: '◐', label: '运行中', color: 'claude' },
  waiting: { glyph: '◆', label: '等待回应', color: 'warning' },
  completed: { glyph: '✓', label: '已完成', color: 'success' },
  failed: { glyph: '✕', label: '失败', color: 'error' },
  cancelled: { glyph: '○', label: '已取消', color: 'inactive' },
  interrupted: { glyph: '○', label: '已中断', color: 'inactive' },
}
const BACKEND: Record<Backend, string> = { dsh: 'DSH', codex: 'Codex' }
const MODE = { desktop: '桌面', headless: '无头' }
const KIND: Record<string, string> = { command: '⌘', tool: '⚙', file: '✎', search: '⌕', message: '…', thinking: '∴', plan: '☰', error: '!', warning: '⚠' }
const active = (status: JobStatus) => ['starting', 'running', 'waiting'].includes(status)

function elapsed(from?: string, to?: string): string {
  if (!from) return ''
  const seconds = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000))
  if (seconds < 60) return seconds + 's'
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm' + String(seconds % 60).padStart(2, '0') + 's'
  return Math.floor(seconds / 3600) + 'h' + String(Math.floor((seconds % 3600) / 60)).padStart(2, '0') + 'm'
}
const clip = (text: string | undefined, length: number) => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > length ? flat.slice(0, length - 1) + '…' : flat
}

async function flash(io: Io, text: string, tone: 'success' | 'error' | 'info') {
  const at = Date.now()
  await io.set('notice', () => ({ text, tone, at }))
  if (tone === 'success') io.after(3000, () => void io.set('notice', value => (value?.at === at ? null : value)))
}
async function act(io: Io, work: () => Promise<unknown>, done?: string) {
  try {
    await work()
    if (done) await flash(io, done, 'success')
  } catch (error) {
    await flash(io, (error as Error).message, 'error')
  }
  await refresh(io)
}

// ---------- tasks ----------

function Card({ ui, io, agent, expanded, full, width }: { ui: Table; io: Io; agent: Subagent; expanded: boolean; full?: string; width: number }): RenderElement {
  const { Box, Text, Button, Markdown } = ui
  const meta = STATUS[agent.status] ?? STATUS.running
  const settings = agent.settings ?? {}
  const facts = [BACKEND[agent.backend], agent.backend === 'dsh' && agent.mode ? MODE[agent.mode] : undefined, settings.preset, settings.model, settings.effort].filter(Boolean).join(' · ')
  const last = agent.activity?.filter(item => item.text).at(-1)
  const plan = agent.plan
  // Codex will not load a thread that a run is still writing.
  const canOpen = agent.sessionId && (agent.backend === 'codex' ? !active(agent.status) : agent.mode === 'desktop')
  const toggle = () => io.set('view', value => ({ ...value, expanded: value.expanded === agent.key ? undefined : agent.key }))
  const showResult = async () => {
    await toggle()
    if (agent.result !== undefined || agent.error) {
      const known = await io.get('results')
      if (!known[agent.jobId]) {
        try {
          const job = await call<{ result?: string }>(io, 'result', { jobId: agent.jobId })
          if (job.result !== undefined) await io.set('results', value => ({ ...value, [agent.jobId]: job.result as string }))
        } catch {}
      }
    }
  }
  return (
    <Box key={'card:' + agent.key} flexDirection="column" borderStyle="round" borderColor={meta.color} paddingX={1} marginBottom={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Box flexShrink={1}>
          <Text color={meta.color} weight="semibold" wrap="truncate-end">
            {meta.glyph} {agent.title || '子智能体'}
          </Text>
        </Box>
        <Text dimColor tabular>
          {meta.label} {elapsed(agent.startedAt ?? agent.createdAt, agent.finishedAt)}
        </Text>
      </Box>
      <Text dimColor size="caption" wrap="truncate-end">
        {facts}
        {agent.turns.length > 1 ? ' · 第 ' + agent.turns.length + ' 轮' : ''}
      </Text>
      {active(agent.status) && last && (
        <Text dimColor wrap="truncate-end">
          {KIND[last.kind] ?? '·'} {last.text}
        </Text>
      )}
      {active(agent.status) && plan && plan.length > 0 && (
        <Text dimColor wrap="truncate-end">
          ☰ {plan.filter(item => item.done).length}/{plan.length} {clip(plan.find(item => !item.done)?.text, width)}
        </Text>
      )}
      {agent.status === 'waiting' && <Text color="warning">{agent.phase === 'waiting-permission' ? '等待权限确认（在 DSH 中处理）' : '子智能体在等待回应'}</Text>}
      {agent.error && <Text color="error">{clip(agent.error, expanded ? 2000 : 160)}</Text>}
      {!expanded && agent.status === 'completed' && agent.result && <Text wrap="wrap">{clip(agent.result, Math.max(80, width * 3))}</Text>}
      {agent.status === 'completed' && !agent.result && <Text dimColor>这一轮没有文本回复</Text>}
      {expanded && (
        <Box flexDirection="column" marginTop={1} gap={1}>
          {agent.promptSummary && (
            <Box flexDirection="column">
              <Text dimColor size="caption">任务</Text>
              <Text>{agent.promptSummary}</Text>
            </Box>
          )}
          {settings.workspace && (
            <Text dimColor size="caption" wrap="truncate-middle">
              工作区 {settings.workspace}
            </Text>
          )}
          {agent.activity && agent.activity.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor size="caption">最近动作</Text>
              {agent.activity.slice(-6).map((item, index) => (
                <Text key={'act:' + index} dimColor wrap="truncate-end">
                  {KIND[item.kind] ?? '·'} {item.text}
                </Text>
              ))}
            </Box>
          )}
          {agent.turns.length > 1 && (
            <Box flexDirection="column">
              <Text dimColor size="caption">交互记录</Text>
              {agent.turns.map((turn, index) => (
                <Text key={'turn:' + turn.jobId} dimColor wrap="truncate-end">
                  {index + 1}. {STATUS[turn.status]?.glyph} {turn.promptSummary ?? turn.jobId}
                </Text>
              ))}
            </Box>
          )}
          {(full ?? agent.result) && (
            <Box flexDirection="column">
              <Text dimColor size="caption">结果</Text>
              <Markdown key={'md:' + agent.jobId} text={full ?? agent.result ?? ''} />
            </Box>
          )}
        </Box>
      )}
      <Box flexDirection="row" gap={2} marginTop={expanded ? 1 : 0}>
        <Button plain key={'more:' + agent.key} onPress={() => void showResult()}>
          {expanded ? '收起' : '详情'}
        </Button>
        {active(agent.status) && (
          <Button plain key={'cancel:' + agent.key} onPress={() => void act(io, () => call(io, 'cancel', { jobId: agent.jobId }), '已请求取消')}>
            取消
          </Button>
        )}
        {canOpen && (
          <Button plain key={'open:' + agent.key} onPress={() => void act(io, () => call(io, 'open', { jobId: agent.jobId }))}>
            {agent.backend === 'dsh' ? '在 DSH 中打开' : '在 Codex 中打开'}
          </Button>
        )}
      </Box>
    </Box>
  )
}

function Tasks({ ui, io, state, expanded, full, width }: { ui: Table; io: Io; state: HubState; expanded?: string; full: Record<string, string>; width: number }): RenderElement {
  const { Box, Text, Button } = ui
  if (!state.subagents.length) {
    const ready = (['dsh', 'codex'] as const).filter(backend => state.config[backend].status === 'ready')
    return (
      <Box flexDirection="column" paddingY={1} gap={1}>
        <Text weight="medium">还没有子智能体任务</Text>
        <Text dimColor>在对话里让 Claude「交给 DSH / Codex 子智能体做…」即可开始。每个任务一张卡片，续接会更新同一张卡片。</Text>
        <Text dimColor>
          本会话配置：{ready.length ? ready.map(backend => BACKEND[backend]).join('、') + ' 已保存' : '尚未保存，首次派发前需要确认一次'}
        </Text>
        {!ready.length && (
          <Button key="goto-config" variant="primary" onPress={() => void io.set('view', value => ({ ...value, tab: 'config' }))}>
            去配置
          </Button>
        )}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {state.subagents.map(agent => (
        Card({ ui, io, agent, expanded: expanded === agent.key, full: full[agent.jobId], width })
      ))}
    </Box>
  )
}

// ---------- configuration ----------

function formValues(backend: Backend, values: ConfigValues) {
  if (backend === 'dsh') {
    const model = typeof values.model === 'object' ? values.model : undefined
    return { mode: values.mode, workspace: values.workspace, preset: values.preset ?? DEFAULT, model: model ? model.provider + '/' + model.model : DEFAULT, effort: model?.reasoningEffort ?? DEFAULT, permission: values.permission ?? DEFAULT }
  }
  return { mode: undefined, workspace: values.workspace, preset: DEFAULT, model: typeof values.model === 'string' ? values.model : DEFAULT, effort: values.effort ?? DEFAULT, permission: values.sandbox ?? DEFAULT }
}
// Another Codex project with the same root: the app cannot tell them apart by folder.
function sharedRoot(catalog: Catalog | undefined, id: string | undefined): string | undefined {
  const project = catalog?.projects?.find(item => item.id === id)
  if (!project) return undefined
  return catalog?.projects?.filter(item => item.id !== id && item.root.toLowerCase() === project.root.toLowerCase()).map(item => item.name).join('」「') || undefined
}
function withField(backend: Backend, values: ConfigValues, field: string, value: string, catalog?: Catalog): ConfigValues {
  const next: ConfigValues = { ...values }
  const unset = value === DEFAULT
  if (field === 'mode') next.mode = value as ConfigValues['mode']
  else if (field === 'workspace') next.workspace = value
  else if (field === 'project') {
    const project = catalog?.projects?.find(item => item.id === value)
    if (value === CUSTOM || !project) delete next.project
    else Object.assign(next, { project: project.id, workspace: project.root })
  }
  else if (field === 'preset') unset ? delete next.preset : (next.preset = value)
  else if (field === 'permission') {
    if (backend === 'dsh') unset ? delete next.permission : (next.permission = value)
    else unset ? delete next.sandbox : (next.sandbox = value)
  } else if (field === 'model') {
    if (backend === 'dsh') {
      const chosen = catalog?.models.find(model => model.provider + '/' + model.id === value)
      const previous = typeof values.model === 'object' ? values.model.reasoningEffort : undefined
      if (unset || !chosen) delete next.model
      else next.model = { provider: chosen.provider!, model: chosen.id, ...(previous && chosen.efforts.includes(previous) ? { reasoningEffort: previous } : {}) }
    } else {
      unset ? delete next.model : (next.model = value)
      const chosen = catalog?.models.find(model => model.id === value)
      if (next.effort && chosen && !chosen.efforts.includes(next.effort)) delete next.effort
    }
  } else if (field === 'effort') {
    if (backend === 'dsh') {
      if (typeof next.model === 'object') next.model = { provider: next.model.provider, model: next.model.model, ...(unset ? {} : { reasoningEffort: value }) }
    } else unset ? delete next.effort : (next.effort = value)
  }
  return next
}

function Config({ ui, io, state, backend, edits, catalog, loading, catalogError }: {
  ui: Table; io: Io; state: HubState; backend: Backend; edits?: ConfigValues; catalog?: Catalog; loading: boolean; catalogError?: string
}): RenderElement {
  // Only surfaces with form fields reach here (mobile is turned away first).
  const { Box, Text, Button, Select, Input } = ui as Elements['desktop']
  const entry = state.config[backend]
  const values = edits ?? entry.values
  const form = formValues(backend, values)
  const defaults = catalog?.defaults ?? {}
  const setField = (field: string, value: string) =>
    io.set('draft', value0 => ({ ...value0, [backend]: withField(backend, value0[backend] ?? entry.values, field, value, catalog) }))
  const save = () =>
    act(io, async () => {
      await call(io, 'saveConfig', { backend, values })
      await io.set('draft', value => ({ ...value, [backend]: undefined }))
    }, BACKEND[backend] + ' 配置已保存')
  const models = catalog?.models ?? []
  const modelKey = (model: Catalog['models'][number]) => (backend === 'dsh' ? model.provider + '/' + model.id : model.id)
  const selected = models.find(model => modelKey(model) === form.model)
  const defaultModel = backend === 'dsh' ? (form.preset !== DEFAULT ? '沿用预设' : '沿用 DSH 默认') + (defaults.model && form.preset === DEFAULT ? '（' + defaults.model + '）' : '') : '沿用 Codex 配置' + (defaults.model ? '（' + defaults.model + '）' : '')
  const efforts = selected?.efforts ?? []
  const status = edits ? '有未保存的修改' : entry.status === 'ready' ? '已保存 · 第 ' + entry.revision + ' 版' : '未保存：已预填上次的值，确认后保存'
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        {(['dsh', 'codex'] as const).map(name => (
          <Button key={'backend:' + name} variant={name === backend ? 'primary' : 'secondary'} onPress={() => void (io.set('view', value => ({ ...value, backend: name })), loadCatalog(io, name))}>
            {BACKEND[name]}
            {state.config[name].status === 'ready' ? ' ✓' : ''}
          </Button>
        ))}
      </Box>
      <Text color={edits ? 'warning' : entry.status === 'ready' ? 'success' : 'subtle'} size="caption">
        {status}
      </Text>
      {backend === 'dsh' ? (
        <Select key="mode:dsh" label="运行方式" value={form.mode} options={[
          { value: 'desktop', label: '桌面 — 在 DSH 应用里可看过程' },
          { value: 'headless', label: '无头 — 后台运行，只在这里看状态' },
        ]} onSelect={value => void setField('mode', value)} />
      ) : (
        <Text color="subtle" size="caption">
          Codex 任务在后台运行，过程看这里的卡片。想看完整对话可以在卡片上点“在 Codex 中打开”，但打开后 Codex 应用会一直占着这个线程，要完全退出应用后，这边才能接着续接。
        </Text>
      )}
      {backend === 'codex' && (catalog?.projects?.length ?? 0) > 0 && (
        <Select key="project:codex" label="项目" value={values.project ?? CUSTOM} options={[
          ...(catalog?.projects ?? []).map(project => ({ value: project.id, label: project.name + ' — ' + project.root })),
          { value: CUSTOM, label: '自定义文件夹…' },
        ]} onSelect={value => void setField('project', value)} />
      )}
      {backend === 'codex' && sharedRoot(catalog, values.project) && (
        <Text color="warning" size="caption">
          「{sharedRoot(catalog, values.project)}」与这个项目同目录。Codex 应用按目录归类线程，可能把它归到另一个项目下；给两个项目设不同的根目录即可避免。
        </Text>
      )}
      {(backend === 'dsh' || !values.project || !(catalog?.projects?.length)) && (
        <Input key={'workspace:' + backend} label={backend === 'dsh' ? '工作区' : '文件夹'} value={form.workspace} submitLabel="应用" onInput={value => void setField('workspace', value)} onSubmit={value => void setField('workspace', value)} />
      )}
      {backend === 'dsh' && (
        <Select key="preset:dsh" label="预设" value={form.preset} options={[
          { value: DEFAULT, label: '沿用 DSH 默认' + (defaults.preset ? '（' + defaults.preset + '）' : '') },
          ...(catalog?.presets ?? []).map(preset => ({ value: preset.id, label: preset.name === preset.id ? preset.id : preset.name + '（' + preset.id + '）' })),
        ]} onSelect={value => void setField('preset', value)} />
      )}
      <Select key={'model:' + backend} label="模型" value={form.model} options={[
        { value: DEFAULT, label: defaultModel },
        ...models.map(model => ({ value: modelKey(model), label: model.name + (model.providerName ? ' · ' + model.providerName : '') })),
      ]} onSelect={value => void setField('model', value)} />
      {(backend === 'codex' || form.model !== DEFAULT) && (
        <Select key={'effort:' + backend} label="推理强度" value={form.effort} options={[
          { value: DEFAULT, label: '沿用默认' + (selected?.defaultEffort ? '（' + selected.defaultEffort + '）' : defaults.effort ? '（' + defaults.effort + '）' : '') },
          ...(efforts.length ? efforts : backend === 'codex' ? ['low', 'medium', 'high', 'xhigh'] : []).map(effort => ({ value: effort, label: effort })),
        ]} onSelect={value => void setField('effort', value)} />
      )}
      <Select key={'permission:' + backend} label={backend === 'dsh' ? '权限' : '沙箱'} value={form.permission} options={[
        { value: DEFAULT, label: '沿用默认' + (defaults.permission ? '（' + defaults.permission + '）' : '') },
        ...(catalog?.permissions ?? ['read-only', 'workspace-write', 'danger-full-access']).map(value => ({ value, label: value })),
      ]} onSelect={value => void setField('permission', value)} />
      {loading && <Text dimColor>正在读取 {BACKEND[backend]} 的可选项…</Text>}
      {catalogError && !loading && (
        <Box flexDirection="row" gap={1}>
          <Text color="error" wrap="truncate-end">读取可选项失败：{catalogError}</Text>
          <Button plain key={'retry-catalog:' + backend} onPress={() => void loadCatalog(io, backend, true)}>
            重试
          </Button>
        </Box>
      )}
      <Box flexDirection="row" gap={1}>
        <Button key={'save:' + backend} variant="primary" onPress={() => void save()}>
          保存 {BACKEND[backend]} 配置
        </Button>
        {edits && (
          <Button key={'discard:' + backend} onPress={() => void io.set('draft', value => ({ ...value, [backend]: undefined }))}>
            放弃修改
          </Button>
        )}
      </Box>
      <Text dimColor size="caption">
        配置只属于当前会话，修改只影响之后新建的任务；续接旧会话始终保留它原来的模型、预设和权限。保存配置不等于授权执行。
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Select key="wake" label="任务结束后" value={state.wake ? 'wake' : 'quiet'} options={[
          { value: 'wake', label: '自动唤醒 Claude 汇报结果' },
          { value: 'quiet', label: '只在面板里提示' },
        ]} onSelect={value => void act(io, () => call(io, 'saveConfig', { wake: value === 'wake' }))} />
      </Box>
    </Box>
  )
}

// ---------- pane ----------

export type PaneData = { state: HubState | null; status: LoadState; current: View; edits: Draft; known: Catalogs; message: Notice | null; full: Record<string, string> }

export function renderPane(io: Io, ui: Table, e: { surface: string; props: { bodyColumns: number } }, data: PaneData): RenderElement {
  const { Box, Text, Button } = ui
  const { state, status, current, edits, known, message, full } = data
  const width = Math.max(24, e.props.bodyColumns - 4)
  const counts = state ? {
    running: state.subagents.filter(agent => active(agent.status)).length,
    done: state.subagents.filter(agent => agent.status === 'completed').length,
    failed: state.subagents.filter(agent => ['failed', 'interrupted'].includes(agent.status)).length,
  } : undefined
  const tab = (name: 'tasks' | 'config', label: string) => (
    <Button key={'tab:' + name} variant={current.tab === name ? 'primary' : 'secondary'} onPress={() => void (async () => {
      await io.set('view', value => ({ ...value, tab: name }))
      if (name === 'config') await loadCatalog(io, current.backend)
    })()}>
      {label}
    </Button>
  )
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginBottom={1}>
        <Box flexDirection="row" gap={1}>
          {tab('tasks', '任务' + (state?.subagents.length ? ' ' + state.subagents.length : ''))}
          {tab('config', '配置')}
        </Box>
        {counts && (
          <Box flexDirection="row" gap={2}>
            <Text color="claude" size="caption" tabular>◐ {counts.running}</Text>
            <Text color="success" size="caption" tabular>✓ {counts.done}</Text>
            {counts.failed > 0 && <Text color="error" size="caption" tabular>✕ {counts.failed}</Text>}
          </Box>
        )}
      </Box>
      {message && (
        <Box marginBottom={1}>
          <Text color={message.tone === 'error' ? 'error' : message.tone === 'success' ? 'success' : 'subtle'}>{message.text}</Text>
        </Box>
      )}
      {!state && (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{status.error ? '后台服务未连接：' + status.error : '后台服务尚未启动，第一次派发任务或打开配置时会自动启动。'}</Text>
          <Button key="connect" variant="primary" onPress={() => void refresh(io, { start: true })}>
            {status.error ? '重新连接' : '启动并连接'}
          </Button>
        </Box>
      )}
      {state && state.dshError && <Text color="warning" wrap="truncate-end">子智能体状态读取失败：{state.dshError}</Text>}
      {state && current.tab === 'tasks' && Tasks({ ui, io, state, expanded: current.expanded, full, width })}
      {state && current.tab === 'config' && (e.surface === 'mobile'
        ? <Text dimColor>手机端暂不支持编辑配置。</Text>
        : Config({ ui, io, state, backend: current.backend, edits: edits[current.backend], catalog: known[current.backend], loading: known.loading === current.backend, catalogError: known.error }))}
    </Box>
  )
}
