/**
 * The `/model-scope` command for the interactive dsh UIs. It runs on the UI
 * command plane: nothing here becomes a model message.
 *
 * Without arguments it opens a menu of question cards (see `ask.ts`);
 * arguments are shortcuts. Where no UI can answer cards it falls back to the
 * status text.
 *
 * dsh shows a command result collapsed to its first line, so every result
 * starts with a one-line summary; details follow on later lines.
 *
 * Changes are written to the plugin's own section of the profile
 * `cordis.patch.yml` through the settings service, exactly like editing that
 * file by hand.
 */

import { type Ask, AskCancelled, AskUnavailable, type Choice, multiple, type Question, single } from './ask.ts'
import { DEFAULT_SETTINGS, isMode, type Mode, type ScopeSettings } from './config.ts'
import { exactPattern, isExactFor, type ModelRef, Scope } from './scope.ts'
import { changedFields, cloneSettings, hideIn, showIn } from './manage.ts'

export type CommandResult = { kind: 'success'; text: string } | { kind: 'error'; text: string }

/** Where the plugin is filtering in this profile. */
export type Surface = 'web' | 'models' | 'none'

export interface ProviderModels {
  id: string
  name: string
  /** Every model of the provider, unfiltered, in the provider's own order. */
  models: Array<{ id: string; name: string }>
  /** Listing this provider's models failed. */
  error?: string
}

/** Everything the command touches outside itself, injectable for tests. */
export interface CommandHost {
  /** Current effective settings. */
  read(): ScopeSettings
  /** Persist changed fields; throws with a user-facing reason when the profile is not writable. */
  write(patch: Partial<ScopeSettings>): Promise<void>
  /** Every provider and its unfiltered models, in registration order. */
  catalog(): Promise<ProviderModels[]>
  /** The default model selection, if known. */
  defaultModel(): ModelRef | undefined
  surface(): Surface
}

export interface Invocation {
  /** Text after the command name. */
  args: string
  /** The model the session last sent a request to. */
  current?: ModelRef
  /** Ask question cards; throws `AskUnavailable` where no UI answers them. */
  ask: Ask
}

export interface ScopeCommand {
  name: string
  description: string
  hint?: string
  run(invocation: Invocation): Promise<CommandResult>
}

type ListField = 'include' | 'favorites'

interface ListSpec {
  field: ListField
  header: string
  noun: string
  intro: string
  addHint: string
  whereLast: string
  removeHint: string
}

/** How to cycle, shown after favorites change. The keys are the browser half's defaults. */
const FAVORITE_USAGE = '轮切：Ctrl+Alt+M 下一个、Ctrl+Alt+Shift+M 上一个（macOS 用 ⌘⌥M），或输入 /fav-next、/fav-prev；/fav 直接挑一个。快捷键可在 dsh 的快捷键设置里改。'

const ok = (text: string): CommandResult => ({ kind: 'success', text })
const fail = (text: string): CommandResult => ({ kind: 'error', text })
const cancelled = (): CommandResult => ok('已取消，没有做任何修改')

/** Options per card page; larger lists are split across pages of one card. */
export const PAGE_SIZE = 30

/** The DeepSeek groups the dsh Web picker always puts first. */
const PINNED_BY_DSH = new Set(['deepseek-account', 'deepseek-official'])
const PINNED_NOTE = '注：Web 选择器总把 DeepSeek 账号和 DeepSeek 官方两个分组放在最前，这是 dsh 自己的规则。'

const MODE_LABELS: Record<Mode, string> = {
  all: 'all：默认全部显示',
  include: 'include：只显示优先级列表里的',
}

const USAGE = [
  '用法：',
  '/model-scope                 打开菜单',
  '/model-scope status          查看当前设置和每个 provider 显示了哪些模型',
  '/model-scope hide <规则…>    隐藏（加入 exclude）',
  '/model-scope show <规则…>    取消隐藏；include 模式下同时加入优先级列表',
  '/model-scope top <规则…>     放到优先级列表最前',
  '/model-scope fav [规则…]     加入收藏；不写规则时打开收藏菜单',
  '/model-scope unfav <规则…>   取消收藏',
  '/model-scope mode all|include',
  '/model-scope reset           恢复默认',
  '规则写法：provider/模型 或 模型；* 是通配符；/正则/flags 写正则',
].join('\n')

function words(rawInput: string): string[] {
  return rawInput.trim().split(/\s+/).filter(Boolean)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameRef(a: ModelRef | undefined, b: ModelRef): boolean {
  return a !== undefined && a.provider === b.provider && a.model === b.model
}

function samePattern(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function withoutPattern(list: readonly string[], pattern: string): string[] {
  return list.filter(item => !samePattern(item, pattern))
}

function providerLabel(provider: { id: string; name: string }): string {
  return provider.name && provider.name !== provider.id ? `${provider.name}（${provider.id}）` : provider.id
}

function clip(items: readonly string[], max = 8): string {
  return items.length <= max ? items.join('、') : `${items.slice(0, max).join('、')} 等 ${items.length} 个`
}

/** Split a long option list into several questions (pages) of one card. */
function paged(id: string, header: string, question: string, options: Choice[], multiSelect: boolean): Question[] {
  if (options.length <= PAGE_SIZE) return [{ id, header, question, options, multiSelect }]
  const pages: Question[] = []
  const total = Math.ceil(options.length / PAGE_SIZE)
  for (let page = 0; page < total; page++) {
    pages.push({
      id: `${id}#${page}`,
      header: `${header} ${page + 1}/${total}`,
      question,
      options: options.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
      multiSelect,
    })
  }
  return pages
}

/** Every selection across the pages of one paged question. */
function pagedSelection(answers: Map<string, { id: string; selected: string[]; custom?: string }>, id: string): string[] {
  const picked: string[] = []
  for (const [key, answer] of answers) {
    if (key === id || key.startsWith(`${id}#`)) picked.push(...multiple(answer))
  }
  return [...new Set(picked)]
}

interface ModelState {
  ref: ModelRef
  name: string
  /** Listed in the model picker. */
  visible: boolean
  /** Hidden by the rules themselves; may still be listed as the kept default model. */
  ruleHidden: boolean
  note: string
}

/** One provider's models with their visibility under a scope, in the provider's own order. */
function modelStates(provider: ProviderModels, scope: Scope, defaultRef: ModelRef | undefined): ModelState[] {
  return provider.models.map((model) => {
    const ref = { provider: provider.id, model: model.id }
    const explained = scope.explain(ref, sameRef(defaultRef, ref))
    const note = explained.reason === 'excluded'
      ? `被规则 ${explained.pattern} 隐藏`
      : explained.reason === 'not-included'
        ? '不在优先级列表里（include 模式）'
        : explained.reason === 'kept-default'
          ? explained.hiddenBy !== undefined
            ? `被规则 ${explained.hiddenBy} 隐藏，作为默认模型仍显示`
            : '不在优先级列表里，作为默认模型仍显示'
          : explained.includeIndex !== undefined
            ? `优先级 #${explained.includeIndex + 1}`
            : ''
    const favorite = scope.favoriteIndex(ref) !== undefined ? '★ 收藏' : ''
    return {
      ref,
      name: model.name,
      visible: explained.visible,
      ruleHidden: explained.reason !== 'shown',
      note: [favorite, note].filter(Boolean).join(' · '),
    }
  })
}

export function createCommands(host: CommandHost): ScopeCommand[] {
  const save = async (draft: ScopeSettings): Promise<boolean> => {
    const patch = changedFields(host.read(), draft)
    if (Object.keys(patch).length === 0) return false
    await host.write(patch)
    return true
  }

  const surfaceNote = (): string => {
    switch (host.surface()) {
      case 'web': return '作用于 Web 模型选择器'
      case 'models': return '作用于本 profile 的模型列表（ACP 等）'
      default: return '当前没有生效（见下方说明）'
    }
  }

  const summary = (catalog: readonly ProviderModels[], scope: Scope): { shown: number; total: number } => {
    const defaultRef = host.defaultModel()
    let shown = 0
    let total = 0
    for (const provider of catalog) {
      for (const state of modelStates(provider, scope, defaultRef)) {
        total++
        if (state.visible) shown++
      }
    }
    return { shown, total }
  }

  const status = async (): Promise<CommandResult> => {
    const settings = host.read()
    const scope = new Scope(settings)
    const catalog = await host.catalog()
    const defaultRef = host.defaultModel()
    const { shown, total } = summary(catalog, scope)
    const lines = [
      `模型范围：${settings.mode} 模式 · 显示 ${shown}/${total} 个模型 · 优先级 ${settings.include.length} 条${settings.favorites.length > 0 ? ` · 收藏 ${settings.favorites.length} 条` : ''} · ${surfaceNote()}`,
    ]
    const visible = new Map<string, string[]>()
    for (const provider of catalog) {
      const states = modelStates(provider, scope, defaultRef)
      visible.set(provider.id, states.filter(state => state.visible).map(state => state.ref.model))
    }
    // Providers that list no models (an unconfigured DeepSeek route, say) never show in the picker.
    const listed = catalog.filter(provider => provider.models.length > 0 || provider.error !== undefined)
    const ordered = scope.orderProviders(listed, provider => provider.id, id => visible.get(id))
    lines.push('', '各 provider（按显示顺序）：')
    for (const provider of ordered) {
      if (provider.error !== undefined) {
        lines.push(`- ${providerLabel(provider)}：读取模型失败（${provider.error}）`)
        continue
      }
      const states = modelStates(provider, scope, defaultRef)
      const hidden = states.filter(state => !state.visible).map(state => state.ref.model)
      const order = scope.orderModels(provider.id, states, state => state.ref.model, defaultRef)
        .map(state => scope.favoriteIndex(state.ref) !== undefined ? `★${state.ref.model}` : state.ref.model)
      lines.push(`- ${providerLabel(provider)}：显示 ${order.length}/${states.length}`
        + (order.length > 0 ? ` · 顺序：${clip(order, 6)}` : '')
        + (hidden.length > 0 ? ` · 隐藏：${clip(hidden)}` : ''))
    }
    lines.push('', settings.include.length > 0
      ? `优先级列表（include）：${settings.include.map((pattern, index) => `${index + 1}. ${pattern}`).join('  ')}`
      : '优先级列表（include）：空')
    lines.push(settings.exclude.length > 0 ? `隐藏规则（exclude）：${settings.exclude.join('、')}` : '隐藏规则（exclude）：空')
    lines.push(settings.favorites.length > 0
      ? `收藏（favorites，轮切顺序）：${settings.favorites.map((pattern, index) => `${index + 1}. ${pattern}`).join('  ')}`
      : '收藏（favorites）：空')
    if (settings.providerOrder.length > 0) lines.push(`provider 顺序：${settings.providerOrder.join(' → ')}`)
    lines.push(`默认模型始终显示（keepDefault）：${settings.keepDefault ? '是' : '否'}`)
    for (const issue of scope.issues) lines.push(`⚠ 无效规则，已忽略：${issue}`)
    if (host.surface() === 'web' && ordered.some(provider => PINNED_BY_DSH.has(provider.id) && provider.models.length > 0)) {
      lines.push(PINNED_NOTE)
    }
    if (host.surface() === 'none') {
      lines.push('注：插件没有找到可以过滤的模型列表（dsh 版本不兼容？），详情见 dsh 日志里 dsh-model-scope 的警告。')
    }
    return ok(lines.join('\n'))
  }

  const pickProvider = async (ask: Ask, catalog: readonly ProviderModels[], question: string, scope: Scope): Promise<ProviderModels | undefined> => {
    const defaultRef = host.defaultModel()
    const usable = catalog.filter(provider => provider.models.length > 0)
    if (usable.length === 0) throw new Error('没有任何 provider 列出模型')
    if (usable.length === 1) return usable[0]
    const options = usable.map((provider) => {
      const states = modelStates(provider, scope, defaultRef)
      return { label: providerLabel(provider), description: `显示 ${states.filter(state => state.visible).length}/${states.length}` }
    })
    const answers = await ask([{ id: 'provider', header: 'Provider', question, options }])
    const answer = single(answers.get('provider'))
    if (answer === undefined) return undefined
    const found = usable.find(provider => providerLabel(provider) === answer || provider.id === answer)
    if (!found) throw new Error(`没有「${answer}」这个 provider`)
    return found
  }

  /** Show/hide: one card per provider, with a page for visible models and one for hidden ones. */
  const toggle = async (ask: Ask, current: ModelRef | undefined): Promise<CommandResult> => {
    const catalog = await host.catalog()
    const before = host.read()
    const provider = await pickProvider(ask, catalog, '要调整哪个 provider 的模型？', new Scope(before))
    if (!provider) return cancelled()
    const defaultRef = host.defaultModel()
    const states = modelStates(provider, new Scope(before), defaultRef)
    const describe = (state: ModelState): string => [
      state.name !== state.ref.model ? state.name : '',
      sameRef(current, state.ref) ? '当前会话在用' : '',
      state.note,
    ].filter(Boolean).join(' · ')
    // A default model kept by keepDefault is hidden by the rules: it belongs on the "show" page.
    const visible = states.filter(state => !state.ruleHidden)
    const hidden = states.filter(state => state.ruleHidden)
    const questions: Question[] = [
      ...visible.length > 0
        ? paged('hide', '隐藏', `${providerLabel(provider)}：勾选要隐藏的模型（当前显示 ${visible.length} 个）`,
          visible.map(state => ({ label: state.ref.model, description: describe(state) })), true)
        : [],
      ...hidden.length > 0
        ? paged('show', '显示', `${providerLabel(provider)}：勾选要重新显示的模型（当前隐藏 ${hidden.length} 个）`,
          hidden.map(state => ({ label: state.ref.model, description: describe(state) })), true)
        : [],
    ]
    const answers = await ask(questions)
    const known = new Set(states.map(state => state.ref.model))
    const toHide = pagedSelection(answers, 'hide')
    const toShow = pagedSelection(answers, 'show')
    const unknown = [...toHide, ...toShow].filter(model => !known.has(model))
    if (unknown.length > 0) return fail(`${providerLabel(provider)} 没有这些模型：${unknown.join('、')}`)
    if (toHide.length === 0 && toShow.length === 0) return ok('没有勾选任何模型，设置没有变化')
    const draft = cloneSettings(before)
    const refOf = (model: string): ModelRef => ({ provider: provider.id, model })
    for (const model of toHide) hideIn(draft, refOf(model))
    const blocked = new Map<string, string>()
    for (const model of toShow) {
      const blocker = showIn(draft, refOf(model))
      if (blocker !== undefined) blocked.set(model, blocker)
    }
    const changed = await save(draft)
    const shownNow = toShow.filter(model => !blocked.has(model))
    const keptDefault = toHide.filter(model => draft.keepDefault && sameRef(defaultRef, refOf(model)))
    const parts = [
      toHide.length > 0 ? `隐藏 ${toHide.length} 个` : '',
      shownNow.length > 0 ? `显示 ${shownNow.length} 个` : '',
    ].filter(Boolean)
    const lines = [parts.length > 0
      ? `已在 ${providerLabel(provider)} ${parts.join('、')}模型${blocked.size > 0 ? `，${blocked.size} 个没能显示` : ''}`
      : `${providerLabel(provider)} 的 ${blocked.size} 个模型没能显示：它们被通配或正则规则隐藏`]
    if (toHide.length > 0) lines.push(`隐藏：${toHide.join('、')}`)
    if (shownNow.length > 0) lines.push(`显示：${shownNow.join('、')}`)
    for (const [model, blocker] of blocked) lines.push(`${model}：仍被规则 ${blocker} 隐藏，要显示它需要改 exclude`)
    if (keptDefault.length > 0) lines.push(`${keptDefault.join('、')}：是默认模型，会继续显示（keepDefault）`)
    if (toHide.some(model => sameRef(current, refOf(model)))) {
      lines.push('当前会话正在用的模型被隐藏了：它还能继续用，只是选择器按钮会显示「请选择模型」。')
    }
    if (!changed && blocked.size === 0) lines.push('设置没有变化')
    return ok(lines.join('\n'))
  }

  /** One editable ordered list: the priority list (`include`) or the favorites. */
  const LISTS: Record<ListField, ListSpec> = {
    include: {
      field: 'include',
      header: '优先级',
      noun: '优先级列表',
      intro: '优先级列表越靠前越优先，同一 provider 分组里按它排序。',
      addHint: '放到列表最前或最后',
      whereLast: '排在已有条目后面，但仍在没列出的模型前面',
      removeHint: '从优先级列表删掉（模型本身不会被隐藏，除非是 include 模式）',
    },
    favorites: {
      field: 'favorites',
      header: '收藏',
      noun: '收藏',
      intro: '快捷键和 /fav-next、/fav-prev 按这个顺序在收藏之间轮切，/fav 可以直接挑一个。',
      addHint: '放到收藏最前或最后',
      whereLast: '排在已有收藏后面',
      removeHint: '取消收藏（模型本身照常显示）',
    },
  }

  /** List menu: add models, move one entry, or remove entries. */
  const listMenu = async (ask: Ask, field: ListField): Promise<CommandResult> => {
    const spec = LISTS[field]
    const list = host.read()[field]
    const actions: Choice[] = [
      { label: '添加模型', description: `选 provider 再勾选模型，${spec.addHint}` },
      ...list.length > 0
        ? [
          { label: '调整一条的位置', description: '最前 / 上移 / 下移 / 最后' },
          { label: '移除条目', description: spec.removeHint },
        ]
        : [],
    ]
    const answers = await ask([{
      id: 'action',
      header: spec.header,
      question: `${spec.intro}当前：${list.length > 0 ? list.join(' → ') : '空'}`,
      options: actions,
    }])
    const action = single(answers.get('action'))
    if (action === undefined) return cancelled()
    if (action === '添加模型') return await addToList(ask, field)
    if (action === '调整一条的位置') return await moveInList(ask, field)
    if (action === '移除条目') return await removeFromList(ask, field)
    return fail(`没有「${action}」这个操作 · 可选：${actions.map(item => item.label).join('、')}`)
  }

  const addToList = async (ask: Ask, field: ListField): Promise<CommandResult> => {
    const spec = LISTS[field]
    const catalog = await host.catalog()
    const before = host.read()
    const scope = new Scope(before)
    const provider = await pickProvider(ask, catalog, '从哪个 provider 添加？', scope)
    if (!provider) return cancelled()
    const defaultRef = host.defaultModel()
    const states = modelStates(provider, scope, defaultRef)
    const candidates = states.filter(state => !before[field].some(pattern => isExactFor(pattern, state.ref)))
    if (candidates.length === 0) return ok(`${providerLabel(provider)} 的模型都已经在${spec.noun}里了`)
    const ordered = scope.orderModels(provider.id, candidates, state => state.ref.model)
      .concat(candidates.filter(state => !state.visible))
    const answers = await ask([
      ...paged('models', '模型', `${providerLabel(provider)}：勾选要加入${spec.noun}的模型（按分组当前顺序加入）`,
        ordered.map(state => ({ label: state.ref.model, description: [state.name !== state.ref.model ? state.name : '', state.visible ? '' : '当前隐藏', state.note].filter(Boolean).join(' · ') })), true),
      { id: 'where', header: '位置', question: `放在${spec.noun}的哪里？`, options: [
        { label: '最前', description: '排在所有已有条目前面' },
        { label: '最后', description: spec.whereLast },
      ] },
    ])
    const picked = pagedSelection(answers, 'models')
    if (picked.length === 0) return ok('没有勾选任何模型，设置没有变化')
    const known = new Map(ordered.map(state => [state.ref.model, state]))
    const unknown = picked.filter(model => !known.has(model))
    if (unknown.length > 0) return fail(`${providerLabel(provider)} 没有这些模型：${unknown.join('、')}`)
    const where = single(answers.get('where')) ?? (field === 'favorites' ? '最后' : '最前')
    const chosen = ordered.filter(state => picked.includes(state.ref.model))
    const patterns = chosen.map(state => exactPattern(state.ref))
    const draft = cloneSettings(before)
    draft[field] = where === '最后' ? [...draft[field], ...patterns] : [...patterns, ...draft[field]]
    await save(draft)
    const after = new Scope(draft)
    const hiddenStill = chosen.filter(state => !after.isVisible(state.ref, sameRef(defaultRef, state.ref))).map(state => state.ref.model)
    return ok([
      `已把 ${patterns.length} 个模型加到${spec.noun}${where === '最后' ? '末尾' : '最前'}`,
      `新列表：${draft[field].join(' → ')}`,
      ...hiddenStill.length > 0
        ? [field === 'favorites'
          ? `注意：${hiddenStill.join('、')} 当前被隐藏，轮切时会跳过`
          : `注意：${hiddenStill.join('、')} 仍被 exclude 隐藏`]
        : [],
      ...field === 'favorites' ? [FAVORITE_USAGE] : [],
    ].join('\n'))
  }

  const moveInList = async (ask: Ask, field: ListField): Promise<CommandResult> => {
    const spec = LISTS[field]
    const before = host.read()
    const labels = before[field].map((pattern, index) => `${index + 1}. ${pattern}`)
    const answers = await ask([
      { id: 'entry', header: '条目', question: '移动哪一条？', options: labels.map(label => ({ label })) },
      { id: 'move', header: '位置', question: '移到哪里？', options: [
        { label: '移到最前' }, { label: '上移一位' }, { label: '下移一位' }, { label: '移到最后' },
      ] },
    ])
    const entry = single(answers.get('entry'))
    const move = single(answers.get('move'))
    if (entry === undefined || move === undefined) return cancelled()
    let index = labels.indexOf(entry)
    if (index < 0) index = before[field].findIndex(pattern => samePattern(pattern, entry))
    if (index < 0) return fail(`${spec.noun}里没有「${entry}」`)
    const list = [...before[field]]
    const [item] = list.splice(index, 1)
    const target = move === '移到最前' ? 0
      : move === '上移一位' ? Math.max(0, index - 1)
        : move === '下移一位' ? Math.min(list.length, index + 1)
          : move === '移到最后' ? list.length
            : -1
    if (target < 0) return fail(`没有「${move}」这个位置`)
    list.splice(target, 0, item!)
    const changed = await save({ ...cloneSettings(before), [field]: list })
    return ok([changed ? `已把 ${item} 移到第 ${target + 1} 位` : `${item} 已经在第 ${target + 1} 位`, `新列表：${list.join(' → ')}`].join('\n'))
  }

  const removeFromList = async (ask: Ask, field: ListField): Promise<CommandResult> => {
    const spec = LISTS[field]
    const before = host.read()
    const labels = before[field].map((pattern, index) => `${index + 1}. ${pattern}`)
    const answers = await ask(paged('entries', '移除', `勾选要从${spec.noun}删掉的条目`, labels.map(label => ({ label })), true))
    const picked = pagedSelection(answers, 'entries')
    if (picked.length === 0) return ok('没有勾选任何条目，设置没有变化')
    const removed = new Set<number>()
    for (const value of picked) {
      let index = labels.indexOf(value)
      if (index < 0) index = before[field].findIndex(pattern => samePattern(pattern, value))
      if (index < 0) return fail(`${spec.noun}里没有「${value}」`)
      removed.add(index)
    }
    const list = before[field].filter((_, index) => !removed.has(index))
    await save({ ...cloneSettings(before), [field]: list })
    const lines = [`已从${spec.noun}移除 ${removed.size} 条`, `新列表：${list.length > 0 ? list.join(' → ') : '空'}`]
    if (field === 'include' && before.mode === 'include') lines.push('include 模式下，只被这些条目选中的模型现在会被隐藏。')
    return ok(lines.join('\n'))
  }

  /** Provider order: materialize the current order, move one provider, write it back. */
  const providers = async (ask: Ask): Promise<CommandResult> => {
    const catalog = await host.catalog()
    const before = host.read()
    const scope = new Scope(before)
    const defaultRef = host.defaultModel()
    const visible = new Map(catalog.map(provider => [provider.id,
      modelStates(provider, scope, defaultRef).filter(state => state.visible).map(state => state.ref.model)]))
    const ordered = scope.orderProviders(catalog.filter(provider => provider.models.length > 0),
      provider => provider.id, id => visible.get(id))
    if (ordered.length < 2) return ok('只有一个 provider 列出了模型，不需要排序')
    const answers = await ask([
      { id: 'provider', header: 'Provider', question: `当前顺序：${ordered.map(provider => provider.id).join(' → ')}。移动哪个？`,
        options: ordered.map(provider => ({ label: providerLabel(provider), description: `显示 ${visible.get(provider.id)?.length ?? 0}/${provider.models.length}` })) },
      { id: 'move', header: '位置', question: '移到哪里？', options: [
        { label: '移到最前' }, { label: '上移一位' }, { label: '下移一位' }, { label: '移到最后' },
        { label: '恢复默认顺序', description: '清空 provider 顺序设置（所有 provider）' },
      ] },
    ])
    const picked = single(answers.get('provider'))
    const move = single(answers.get('move'))
    if (move === '恢复默认顺序') {
      const changed = await save({ ...cloneSettings(before), providerOrder: [] })
      return ok(changed ? '已恢复默认的 provider 顺序' : 'provider 顺序本来就是默认的')
    }
    if (picked === undefined || move === undefined) return cancelled()
    const index = ordered.findIndex(provider => providerLabel(provider) === picked || provider.id === picked)
    if (index < 0) return fail(`没有「${picked}」这个 provider`)
    const ids = ordered.map(provider => provider.id)
    const [id] = ids.splice(index, 1)
    const target = move === '移到最前' ? 0
      : move === '上移一位' ? Math.max(0, index - 1)
        : move === '下移一位' ? Math.min(ids.length, index + 1)
          : move === '移到最后' ? ids.length
            : -1
    if (target < 0) return fail(`没有「${move}」这个位置`)
    ids.splice(target, 0, id!)
    // Keep ids of providers that are configured but not registered right now.
    const absent = before.providerOrder.filter(item => !ids.some(known => samePattern(known, item)))
    await save({ ...cloneSettings(before), providerOrder: [...ids, ...absent] })
    const lines = [`已把 ${id} 移到第 ${target + 1} 位`, `新顺序：${ids.join(' → ')}`]
    if (host.surface() === 'web' && ids.some(item => PINNED_BY_DSH.has(item))) lines.push(PINNED_NOTE)
    return ok(lines.join('\n'))
  }

  const setMode = async (mode: Mode): Promise<CommandResult> => {
    const before = host.read()
    if (before.mode === mode) return ok(`已经是 ${mode} 模式`)
    if (mode === 'include' && before.include.length === 0) {
      return fail('优先级列表是空的，切到 include 模式会隐藏所有模型 · 先用「调整模型优先级 → 添加模型」把要显示的模型加进来')
    }
    await save({ ...cloneSettings(before), mode })
    return ok(mode === 'include'
      ? `已切到 include 模式：只显示优先级列表里的模型（${before.include.length} 条规则）`
      : '已切到 all 模式：默认全部显示，只隐藏 exclude 里的')
  }

  const mode = async (ask: Ask): Promise<CommandResult> => {
    const before = host.read()
    const answers = await ask([{
      id: 'mode',
      header: '模式',
      question: `当前是 ${before.mode} 模式。切换到：`,
      options: [
        { label: MODE_LABELS.all, description: '没列出的模型照常显示，只隐藏 exclude 命中的' },
        { label: MODE_LABELS.include, description: `白名单：只显示优先级列表命中的（现在 ${before.include.length} 条）` },
      ],
    }])
    const answer = single(answers.get('mode'))
    if (answer === undefined) return cancelled()
    const picked = (Object.keys(MODE_LABELS) as Mode[]).find(key => MODE_LABELS[key] === answer || key === answer)
    if (picked === undefined) return fail(`没有「${answer}」这个模式 · 可选：all、include`)
    return await setMode(picked)
  }

  const reset = async (ask?: Ask): Promise<CommandResult> => {
    if (ask) {
      const answers = await ask([{
        id: 'confirm',
        header: '恢复默认',
        question: '清空优先级列表、隐藏规则和 provider 顺序，切回 all 模式？',
        options: [{ label: '恢复默认' }, { label: '取消' }],
      }])
      if (single(answers.get('confirm')) !== '恢复默认') return cancelled()
    }
    const changed = await save(cloneSettings(DEFAULT_SETTINGS))
    return ok(changed ? '已恢复默认：所有模型都会显示，顺序和 dsh 原来一样' : '本来就是默认设置')
  }

  /** `hide|show|top <pattern…>` shortcuts. */
  const patternShortcut = async (verb: 'hide' | 'show' | 'top' | 'fav' | 'unfav', patterns: string[]): Promise<CommandResult> => {
    const usageLine = USAGE.split('\n').find(line => line.startsWith(`/model-scope ${verb} `))?.trim() ?? USAGE
    if (patterns.length === 0) return fail(`缺少规则 · ${usageLine}`)
    const before = host.read()
    const draft = cloneSettings(before)
    for (const pattern of patterns) {
      const probe = new Scope({ ...DEFAULT_SETTINGS, exclude: [pattern] })
      if (probe.issues.length > 0) return fail(`规则「${pattern}」无效：${probe.issues[0]}`)
    }
    if (verb === 'hide') {
      for (const pattern of patterns) if (!draft.exclude.some(item => samePattern(item, pattern))) draft.exclude.push(pattern)
      const changed = await save(draft)
      return ok(changed ? `已隐藏：${patterns.join('、')}` : '这些规则已经在隐藏列表里了')
    }
    if (verb === 'fav') {
      for (const pattern of patterns) if (!draft.favorites.some(item => samePattern(item, pattern))) draft.favorites.push(pattern)
      const changed = await save(draft)
      return ok([changed ? `已收藏：${patterns.join('、')}` : '这些规则已经在收藏里了', `收藏：${draft.favorites.join(' → ')}`, FAVORITE_USAGE].join('\n'))
    }
    if (verb === 'unfav') {
      for (const pattern of patterns) draft.favorites = withoutPattern(draft.favorites, pattern)
      const changed = await save(draft)
      return ok([changed ? `已取消收藏：${patterns.join('、')}` : '设置没有变化：这些规则不在收藏里', `收藏：${draft.favorites.length > 0 ? draft.favorites.join(' → ') : '空'}`].join('\n'))
    }
    if (verb === 'top') {
      let include = draft.include
      for (const pattern of patterns) include = withoutPattern(include, pattern)
      draft.include = [...patterns, ...include]
      await save(draft)
      return ok([`已放到优先级列表最前：${patterns.join('、')}`, `新列表：${draft.include.join(' → ')}`].join('\n'))
    }
    for (const pattern of patterns) {
      draft.exclude = withoutPattern(draft.exclude, pattern)
      if (draft.mode === 'include' && !draft.include.some(item => samePattern(item, pattern))) draft.include.push(pattern)
    }
    const changed = await save(draft)
    const lines = [changed ? `已取消隐藏：${patterns.join('、')}` : '设置没有变化：这些规则不在隐藏列表里']
    const remaining = draft.exclude
    if (remaining.length > 0) lines.push(`隐藏规则还剩：${remaining.join('、')}（如果模型仍被其中某条命中，会继续隐藏）`)
    return ok(lines.join('\n'))
  }

  const menu = async (ask: Ask, current: ModelRef | undefined): Promise<CommandResult> => {
    const settings = host.read()
    const catalog = await host.catalog()
    const { shown, total } = summary(catalog, new Scope(settings))
    const actions: Array<{ label: string; description: string; run: () => Promise<CommandResult> }> = [
      { label: '显示/隐藏模型', description: `按 provider 勾选 · 现在显示 ${shown}/${total}`, run: () => toggle(ask, current) },
      { label: '调整模型优先级', description: `优先级列表 ${settings.include.length} 条`, run: () => listMenu(ask, 'include') },
      { label: '收藏与轮切', description: settings.favorites.length > 0 ? `收藏 ${settings.favorites.length} 条 · 快捷键或 /fav-next 轮切` : '收藏常用模型，用快捷键在它们之间轮切', run: () => listMenu(ask, 'favorites') },
      { label: '调整 provider 顺序', description: settings.providerOrder.length > 0 ? settings.providerOrder.join(' → ') : '默认顺序', run: () => providers(ask) },
      { label: '切换模式', description: `当前 ${settings.mode}`, run: () => mode(ask) },
      { label: '查看状态', description: '每个 provider 显示了哪些模型', run: status },
      { label: '恢复默认', description: '清空所有设置', run: () => reset(ask) },
    ]
    const answers = await ask([{ id: 'action', header: '模型范围', question: '要做什么？', options: actions.map(({ label, description }) => ({ label, description })) }])
    const answer = single(answers.get('action'))
    if (answer === undefined) return cancelled()
    const chosen = actions.find(action => action.label === answer)
    if (!chosen) return fail(`没有「${answer}」这个操作 · 可选：${actions.map(action => action.label).join('、')}`)
    return await chosen.run()
  }

  return [{
    name: 'model-scope',
    description: '模型范围：选择模型选择器显示哪些模型、按什么顺序（不带参数打开菜单）',
    hint: '[status | hide | show | top | fav | unfav | mode | reset]',
    async run({ args, current, ask }) {
      const [verb, ...rest] = words(args)
      try {
        switch (verb?.toLowerCase()) {
          case undefined:
            return await menu(ask, current)
          case 'status':
          case '状态':
            return await status()
          case 'hide':
          case 'show':
          case 'top':
          case 'unfav':
            return await patternShortcut(verb.toLowerCase() as 'hide' | 'show' | 'top' | 'unfav', rest)
          case 'fav':
            return rest.length === 0 ? await listMenu(ask, 'favorites') : await patternShortcut('fav', rest)
          case 'mode': {
            const value = rest[0]?.toLowerCase()
            if (value === undefined) return await mode(ask)
            if (!isMode(value)) return fail('模式只能是 all 或 include')
            return await setMode(value)
          }
          case 'reset':
            return await reset()
          case 'help':
            return ok(USAGE)
          default:
            return fail(`不认识「${verb}」这个参数\n${USAGE}`)
        }
      } catch (error) {
        if (error instanceof AskUnavailable) {
          const result = await status()
          return ok(`${result.text}\n\n这个界面不能弹出卡片，可以用参数操作：\n${USAGE}`)
        }
        if (error instanceof AskCancelled) return cancelled()
        return fail(`操作失败：${errorMessage(error)}`)
      }
    },
  }]
}
