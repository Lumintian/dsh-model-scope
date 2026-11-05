/**
 * Browser half of @lumintian/dsh-model-scope, in dsh's lazy-CJS factory
 * format (see dsh `packages/client/modules`). Hand-written plain JavaScript:
 * it needs no build step; only the optional settings page lazily requires React.
 *
 * - Shortcuts: next / previous favorite model for the session on screen.
 *   Rebindable in dsh's shortcut settings.
 * - `/fav`: popup of the favorites; `/fav-next`, `/fav-prev`: cycle without a
 *   shortcut (Linux Web admits no extra shortcut combinations).
 * - `/model-scope`: a bare menu pick or Enter runs it at once instead of
 *   waiting for arguments; typed arguments keep the host command's own path.
 *
 * Favorites come from the plugin's own settings namespace (`model-scope`),
 * read through `configForms`; the models come from the same per-session
 * directory the model picker uses, so only models the picker lists are
 * cycled, and a switch goes through the picker's own `select`.
 */
window.__ModuleLoader__.load({
  id: '@lumintian/dsh-model-scope',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** Settings namespace (profile entry id) of the host plugin. */
    const NAMESPACE = 'model-scope'
    const LOCALE_NS = 'modelScope'
    const MARK = /^★\s*/u
    /** dsh's Web picker always shows these two groups first. */
    const PINNED = ['deepseek-account', 'deepseek-official']

    const zh = {
      'shortcut.next': '切换到下一个收藏模型',
      'shortcut.prev': '切换到上一个收藏模型',
      'command.fav': '收藏的模型：直接选一个切换',
      'command.next': '切换到下一个收藏模型',
      'command.prev': '切换到上一个收藏模型',
      'search.placeholder': '搜索收藏的模型…',
      'search.empty': '还没有收藏模型，用 /model-scope 添加',
      'search.noResults': '没有匹配的收藏模型',
      'notice.switched': '已切换到 {name}（收藏 {index}/{total}）',
      'notice.only': '只收藏了 {name} 一个模型，当前已在使用',
      'notice.none': '还没有可轮切的收藏模型：用 /model-scope → 收藏与轮切 添加（被隐藏的收藏会跳过）',
      'notice.loading': '收藏列表还在加载，请稍后再试',
      'notice.subagent': '子智能体会话不能切换模型',
      'notice.failed': '切换模型失败：{message}',
      'blocked.noSession': '没有打开的会话',
      'provider.account': 'DeepSeek 账号',
    }
    const en = {
      'shortcut.next': 'Switch to the next favorite model',
      'shortcut.prev': 'Switch to the previous favorite model',
      'command.fav': 'Favorite models: pick one to switch to',
      'command.next': 'Switch to the next favorite model',
      'command.prev': 'Switch to the previous favorite model',
      'search.placeholder': 'Search favorite models…',
      'search.empty': 'No favorite models yet — add some with /model-scope',
      'search.noResults': 'No matching favorite models',
      'notice.switched': 'Switched to {name} (favorite {index}/{total})',
      'notice.only': '{name} is the only favorite and is already in use',
      'notice.none': 'No favorite models to cycle: add some with /model-scope → favorites (hidden favorites are skipped)',
      'notice.loading': 'Favorites are still loading, try again in a moment',
      'notice.subagent': 'Subagent sessions cannot switch models',
      'notice.failed': 'Switching models failed: {message}',
      'blocked.noSession': 'No session is open',
      'provider.account': 'DeepSeek Account',
    }

    /** Parse `/pattern/flags` as a regular expression, anything else as a case-insensitive whole-name glob. */
    function parseMatch(match) {
      const trimmed = String(match).trim()
      if (!trimmed) throw new Error('pattern is empty')
      const literal = /^\/(.+)\/([a-z]*)$/s.exec(trimmed)
      if (literal) return new RegExp(literal[1], (literal[2] || '').replace(/[gy]/g, ''))
      const source = trimmed.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
      return new RegExp(`^${source}$`, 'i')
    }

    function compile(patterns) {
      const compiled = []
      for (const pattern of Array.isArray(patterns) ? patterns : []) {
        if (typeof pattern !== 'string') continue
        try { compiled.push(parseMatch(pattern)) } catch { /* the host reports invalid patterns */ }
      }
      return compiled
    }

    /** Groups in the order the Web picker shows them. */
    function pickerOrder(groups) {
      const rank = id => (PINNED.indexOf(id) >= 0 ? PINNED.indexOf(id) : PINNED.length)
      return [...groups].sort((a, b) => rank(a.id) - rank(b.id))
    }

    /**
     * The favorites the picker currently lists, in favorites order: each
     * pattern adds the models it matches, in picker order, without repeats.
     */
    function favoriteChoices(groups, patterns) {
      const choices = []
      const seen = new Set()
      const ordered = pickerOrder(Array.isArray(groups) ? groups : [])
      for (const regex of compile(patterns)) {
        for (const group of ordered) {
          for (const model of Array.isArray(group.models) ? group.models : []) {
            const key = `${group.id}/${model.id}`
            if (seen.has(key) || !(regex.test(model.id) || regex.test(key))) continue
            seen.add(key)
            choices.push({
              provider: group.id,
              providerName: group.name || group.id,
              model: model.id,
              name: String(model.name || model.id).replace(MARK, ''),
              defaultEffort: model.reasoning ? model.reasoning.defaultEffort : undefined,
            })
          }
        }
      }
      return choices
    }

    /** The choice `delta` steps from the current model; the first (or last) one when the current model is not a favorite. */
    function step(choices, current, delta) {
      if (choices.length === 0) return undefined
      const index = current ? choices.findIndex(c => c.provider === current.provider && c.model === current.model) : -1
      if (index < 0) return { choice: delta > 0 ? choices[0] : choices[choices.length - 1], index: delta > 0 ? 0 : choices.length - 1, same: false }
      const next = ((index + delta) % choices.length + choices.length) % choices.length
      return { choice: choices[next], index: next, same: next === index }
    }

    /** The selection the picker would submit for this choice: keep the effort on the same route, else the model's default. */
    function selectionFor(choice, current) {
      const sameRoute = current && current.provider === choice.provider && current.model === choice.model
      const effort = sameRoute && current.reasoningEffort !== undefined ? current.reasoningEffort : choice.defaultEffort
      return { provider: choice.provider, model: choice.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    }

    function errorText(error) {
      if (error && typeof error === 'object' && 'message' in error) return String(error.message)
      return String(error)
    }

    Object.assign(zh, {
      'manage.nav': '模型管理',
      'manage.intro': '管理所有 provider 的模型显示、收藏与优先级。模型排序与收藏轮切顺序相互独立。',
      'manage.search': '搜索 provider 或模型名称、ID…',
      'manage.all': '全部', 'manage.visible': '可见', 'manage.hidden': '隐藏', 'manage.favorites': '收藏',
      'manage.refresh': '刷新', 'manage.loading': '正在加载模型目录…', 'manage.saving': '正在保存…',
      'manage.empty': '没有已注册的模型', 'manage.noResults': '没有符合搜索或筛选条件的模型',
      'manage.readonly': '当前配置为只读，不能修改模型设置。',
      'manage.waiting': '正在同步最新配置，暂时不能修改；若未恢复，请刷新。',
      'manage.inactive': '模型范围规则暂未作用于模型选择器，请检查插件状态。',
      'manage.stale': '配置已被其他页面修改，请刷新后重试',
      'manage.refused': '配置写入未被接受，已重新读取最新配置，请重试',
      'manage.favorite': '收藏', 'manage.unfavorite': '取消收藏',
      'manage.hide': '隐藏', 'manage.show': '恢复显示',
      'manage.top': '置顶', 'manage.up': '上移', 'manage.down': '下移',
      'manage.default': '默认模型', 'manage.protected': '默认保留',
      'manage.count': '{shown} / {total} 个模型',
      'manage.sortBlocked': '请先恢复显示，再调整模型顺序',
    })
    Object.assign(en, {
      'manage.nav': 'Model management',
      'manage.intro': 'Manage model visibility, favorites and priority across all providers. Model priority and favorite cycling order are independent.',
      'manage.search': 'Search provider or model names and IDs…',
      'manage.all': 'All', 'manage.visible': 'Visible', 'manage.hidden': 'Hidden', 'manage.favorites': 'Favorites',
      'manage.refresh': 'Refresh', 'manage.loading': 'Loading model directory…', 'manage.saving': 'Saving…',
      'manage.empty': 'No registered models', 'manage.noResults': 'No models match the search or filter',
      'manage.readonly': 'This configuration is read-only. Model settings cannot be changed.',
      'manage.waiting': 'Synchronizing configuration. Changes are disabled; refresh if this persists.',
      'manage.inactive': 'Model scope rules are not currently applied to the model picker. Check plugin status.',
      'manage.stale': 'Configuration changed in another editor. Refresh and try again.',
      'manage.refused': 'The configuration write was refused. Latest settings have been reloaded; try again.',
      'manage.favorite': 'Favorite', 'manage.unfavorite': 'Unfavorite',
      'manage.hide': 'Hide', 'manage.show': 'Restore visibility',
      'manage.top': 'Move to top', 'manage.up': 'Move up', 'manage.down': 'Move down',
      'manage.default': 'Default model', 'manage.protected': 'Default retained',
      'manage.count': '{shown} / {total} models',
      'manage.sortBlocked': 'Restore visibility before changing model priority',
    })

    // Mirror the public wire contract, never the host's scope rules.
    const MANAGE_ACTIONS = ['favorite', 'unfavorite', 'hide', 'show', 'top', 'up', 'down']
    const record = value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid model management response')
      return value
    }
    const text = value => {
      if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new Error('Expected a non-empty string')
      return value
    }
    const revision = value => {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Expected a settings revision')
      return value
    }
    const codec = (typeSymbol, parse) => ({ mode: 'strict', typeSymbol, create: () => ({ parse }) })
    function managementSnapshot(value) {
      const data = record(value)
      if (!Array.isArray(data.providers) || !Array.isArray(data.issues) || !data.issues.every(item => typeof item === 'string') || typeof data.writable !== 'boolean') throw new Error('Invalid management snapshot')
      revision(data.revision)
      for (const provider of data.providers) {
        record(provider)
        text(provider.id)
        if (typeof provider.name !== 'string' || !Array.isArray(provider.models)) throw new Error('Invalid management provider')
        for (const model of provider.models) {
          record(model)
          text(model.id)
          if (typeof model.name !== 'string' || typeof model.reason !== 'string' || !['visible', 'ruleHidden', 'favorite', 'default', 'up', 'down'].every(key => typeof model[key] === 'boolean')) throw new Error('Invalid management model')
        }
      }
      return data
    }
    function managementPlan(value) {
      const data = record(value)
      if (data.ok === false && typeof data.error === 'string') return data
      if (data.ok !== true || !Array.isArray(data.ops)) throw new Error('Invalid management plan')
      revision(data.revision)
      for (const op of data.ops) {
        record(op)
        if (!['set', 'unset'].includes(op.op) || !Array.isArray(op.path) || !op.path.every(part => typeof part === 'string') || (op.op === 'set' && !Object.hasOwn(op, 'value'))) throw new Error('Invalid management operation')
      }
      return data
    }
    const managementDescriptors = [
      {
        id: '@lumintian/dsh-model-scope#modelScope/snapshot', service: 'modelScope', namespace: 'modelScope', method: 'snapshot',
        invocation: { kind: 'direct' }, parameters: [], result: codec('ManagementSnapshot', managementSnapshot),
      },
      {
        id: '@lumintian/dsh-model-scope#modelScope/plan', service: 'modelScope', namespace: 'modelScope', method: 'plan',
        invocation: { kind: 'direct' },
        parameters: [
          { name: 'action', wire: 'action', source: 'json', codec: codec('ManageAction', value => {
            const action = text(value)
            if (!MANAGE_ACTIONS.includes(action)) throw new Error('Unknown model management action')
            return action
          }) },
          { name: 'provider', wire: 'provider', source: 'json', codec: codec('string', text) },
          { name: 'model', wire: 'model', source: 'json', codec: codec('string', text) },
          { name: 'expectedRevision', wire: 'expectedRevision', source: 'json', codec: codec('number', revision) },
        ],
        result: codec('ManagementPlan', managementPlan),
      },
    ]

    /** Search affects rendering only; move neighbors and rule decisions stay on the host. */
    function managementGroups(providers, query, filter) {
      const search = query.trim().toLocaleLowerCase()
      return providers.map(provider => ({ ...provider, models: provider.models.filter(model => {
        const matches = !search || `${provider.id} ${provider.name} ${model.id} ${model.name}`.toLocaleLowerCase().includes(search)
        return matches && (filter === 'all' || (filter === 'visible' && model.visible) || (filter === 'hidden' && !model.visible) || (filter === 'favorites' && model.favorite))
      }) })).filter(provider => provider.models.length > 0 || (provider.error && !search && filter === 'all'))
    }

    /** Page-owned observable: late RPC responses cannot overwrite a newer read or outlive the page. */
    function createManagementController(remote, form, t) {
      let state = { data: undefined, formState: form.getSnapshot(), loading: false, busy: false, error: '' }
      let active = false
      let readSequence = 0
      let writeSequence = 0
      let unsubscribe
      const listeners = new Set()
      const publish = patch => {
        state = { ...state, ...patch }
        for (const listener of listeners) listener()
      }
      const unwrap = result => {
        if (!result || result.ok !== true) throw new Error(result && result.error ? errorText(result.error) : 'Invalid model management RPC response')
        return result.value
      }
      const writable = () => Boolean(active && !state.loading && !state.busy && state.data && state.data.writable && state.formState.status === 'ready' && state.formState.writable && state.formState.revision === state.data.revision)
      const refresh = async (clearError = true) => {
        if (!active) return
        const sequence = ++readSequence
        publish({ loading: true, formState: form.getSnapshot(), ...(clearError ? { error: '' } : {}) })
        try {
          const data = managementSnapshot(unwrap(await remote.snapshot()))
          if (active && sequence === readSequence) publish({ data, loading: false, formState: form.getSnapshot() })
        } catch (error) {
          if (active && sequence === readSequence) publish({ loading: false, error: errorText(error) })
        }
      }
      const change = async (action, provider, model) => {
        if (!writable()) return
        const expectedRevision = state.data.revision
        const sequence = ++writeSequence
        publish({ busy: true, error: '' })
        try {
          const plan = managementPlan(unwrap(await remote.plan(action, provider, model, expectedRevision)))
          if (!active || sequence !== writeSequence) return
          if (!plan.ok) throw new Error(plan.error)
          const latest = form.getSnapshot()
          if (plan.revision !== expectedRevision || latest.revision !== expectedRevision || latest.status !== 'ready' || !latest.writable) throw new Error(t('manage.stale'))
          // The public form owns authorization, serialization, revision fencing and recovery.
          if (plan.ops.length > 0 && !await form.mutate(plan.ops, plan.revision)) throw new Error(t('manage.refused'))
        } catch (error) {
          if (active && sequence === writeSequence) publish({ error: errorText(error) })
        } finally {
          if (active && sequence === writeSequence) {
            publish({ busy: false })
            await refresh(false)
          }
        }
      }
      return {
        getSnapshot: () => state,
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
        refresh, change, writable,
        start: () => {
          if (active) return
          active = true
          unsubscribe = form.subscribe(() => {
            const next = form.getSnapshot()
            if (next.revision === state.formState.revision && next.status === state.formState.status && next.writable === state.formState.writable) return
            void refresh(false)
          })
          void refresh()
        },
        stop: () => {
          active = false
          readSequence++
          writeSequence++
          if (unsubscribe) unsubscribe()
          unsubscribe = undefined
          state = { ...state, busy: false, loading: false }
        },
      }
    }

    const managementCss = `
.dsh-model-scope{max-width:960px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.5}
.dsh-model-scope h2,.dsh-model-scope h3,.dsh-model-scope p{margin:0}
.dsh-model-scope h2{font-size:18px}.dsh-model-scope h3{font-size:15px}
.dsh-model-scope .ms-intro,.dsh-model-scope .ms-meta,.dsh-model-scope .ms-reason{color:var(--dsw-alias-label-tertiary)}
.dsh-model-scope .ms-intro{margin:8px 0 16px}.dsh-model-scope .ms-toolbar,.dsh-model-scope .ms-actions,.dsh-model-scope .ms-heading,.dsh-model-scope .ms-badges{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-model-scope .ms-toolbar{margin-bottom:16px}.dsh-model-scope input,.dsh-model-scope select,.dsh-model-scope button{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:6px;padding:6px 10px;min-height:34px}
.dsh-model-scope input{flex:1;min-width:180px}.dsh-model-scope button{cursor:pointer}.dsh-model-scope button:disabled{opacity:.45;cursor:not-allowed}
.dsh-model-scope button:focus-visible,.dsh-model-scope input:focus-visible,.dsh-model-scope select:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.dsh-model-scope .ms-provider{margin:18px 0}.dsh-model-scope .ms-heading{margin-bottom:8px}.dsh-model-scope .ms-meta{font-size:12px;overflow-wrap:anywhere}
.dsh-model-scope .ms-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
.dsh-model-scope .ms-row{background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:10px;padding:12px;display:flex;align-items:center;gap:12px}
.dsh-model-scope .ms-identity{flex:1;min-width:0}.dsh-model-scope .ms-name{font-weight:500;overflow-wrap:anywhere}.dsh-model-scope code{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-model-scope .ms-badges{gap:5px;margin:5px 0}.dsh-model-scope .ms-badge{border:1px solid var(--dsw-alias-border-l3);border-radius:4px;padding:0 5px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-model-scope .ms-reason{font-size:12px;overflow-wrap:anywhere}.dsh-model-scope .ms-actions{justify-content:flex-end}.dsh-model-scope .ms-actions button{font-size:12px;padding:4px 7px;min-height:30px}
.dsh-model-scope .ms-notice{margin:10px 0;padding:10px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;overflow-wrap:anywhere}.dsh-model-scope .ms-error{color:var(--dsw-alias-state-error-primary)}
@media(max-width:700px){.dsh-model-scope .ms-row{align-items:stretch;flex-direction:column}.dsh-model-scope .ms-actions{justify-content:flex-start}.dsh-model-scope input{width:100%;flex-basis:100%;min-width:0}.dsh-model-scope .ms-toolbar>select{flex:1}}
`

    /** React comes from the optional registration, never from the legacy shortcuts/commands path. */
    function ManagementPage({ react: React, controller, t }) {
      const h = React.createElement
      const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
      const [query, setQuery] = React.useState('')
      const [filter, setFilter] = React.useState('all')
      React.useEffect(() => { controller.start(); return controller.stop }, [controller])
      const data = state.data
      const canWrite = controller.writable()
      const providers = data ? managementGroups(data.providers, query, filter) : []
      const total = data ? data.providers.reduce((count, provider) => count + provider.models.length, 0) : 0
      const shown = providers.reduce((count, provider) => count + provider.models.length, 0)
      const notice = (message, error = false, key = message) => h('p', { key, className: `ms-notice${error ? ' ms-error' : ''}`, role: error ? 'alert' : 'status' }, message)
      const button = (label, action, provider, model, disabled = false) => h('button', {
        type: 'button', disabled: !canWrite || disabled,
        title: disabled && model.ruleHidden ? t('manage.sortBlocked') : label,
        'aria-label': `${label}: ${provider.id}/${model.id}`,
        ...(action === 'favorite' || action === 'unfavorite' ? { 'aria-pressed': model.favorite } : {}),
        onClick: () => { void controller.change(action, provider.id, model.id) },
      }, label)
      const modelRow = (provider, model) => h('li', { key: model.id, className: 'ms-row' },
        h('div', { className: 'ms-identity' },
          h('div', { className: 'ms-name' }, model.name || model.id),
          h('code', null, model.id),
          h('div', { className: 'ms-badges' },
            model.favorite ? h('span', { className: 'ms-badge' }, `★ ${t('manage.favorite')}`) : null,
            !model.visible ? h('span', { className: 'ms-badge' }, t('manage.hidden')) : null,
            model.default ? h('span', { className: 'ms-badge' }, t(model.ruleHidden && model.visible ? 'manage.protected' : 'manage.default')) : null),
          model.reason ? h('p', { className: 'ms-reason' }, model.reason) : null),
        h('div', { className: 'ms-actions' },
          button(t(model.favorite ? 'manage.unfavorite' : 'manage.favorite'), model.favorite ? 'unfavorite' : 'favorite', provider, model),
          button(t(model.ruleHidden ? 'manage.show' : 'manage.hide'), model.ruleHidden ? 'show' : 'hide', provider, model),
          button(t('manage.top'), 'top', provider, model, model.ruleHidden),
          button(t('manage.up'), 'up', provider, model, model.ruleHidden || !model.up),
          button(t('manage.down'), 'down', provider, model, model.ruleHidden || !model.down)))
      const providerSection = provider => h('section', { key: provider.id, className: 'ms-provider' },
        h('div', { className: 'ms-heading' }, h('h3', null, provider.name || provider.id), h('code', null, provider.id)),
        provider.error ? notice(provider.error, true) : null,
        h('ul', { className: 'ms-list' }, ...provider.models.map(model => modelRow(provider, model))))
      return h('section', { className: 'dsh-model-scope', 'aria-busy': state.loading || state.busy },
        h('style', null, managementCss),
        h('h2', null, t('manage.nav')),
        h('p', { className: 'ms-intro' }, t('manage.intro')),
        h('div', { className: 'ms-toolbar' },
          h('input', { type: 'search', value: query, placeholder: t('manage.search'), 'aria-label': t('manage.search'), onChange: event => setQuery(event.target.value) }),
          h('select', { value: filter, 'aria-label': t('manage.nav'), onChange: event => setFilter(event.target.value) },
            ...['all', 'visible', 'hidden', 'favorites'].map(value => h('option', { key: value, value }, t(`manage.${value}`)))),
          h('button', { type: 'button', disabled: state.busy || state.loading, onClick: () => { void controller.refresh() } }, t('manage.refresh'))),
        state.error ? notice(state.error, true) : null,
        state.busy ? notice(t('manage.saving')) : state.loading ? notice(t('manage.loading')) : null,
        data && state.formState.status !== 'ready' ? notice(t('manage.waiting')) : data && (!data.writable || !state.formState.writable) ? notice(t('manage.readonly')) : data && state.formState.revision !== data.revision ? notice(t('manage.waiting')) : null,
        data && data.surface === 'none' ? notice(t('manage.inactive')) : null,
        ...(data ? data.issues.map((issue, index) => notice(issue, false, `issue-${index}`)) : []),
        data ? h('p', { className: 'ms-meta' }, t('manage.count', { shown, total })) : null,
        data && providers.length === 0 ? notice(t(total === 0 ? 'manage.empty' : 'manage.noResults')) : null,
        ...providers.map(providerSection))
    }

    function installManagement(ctx, form, t) {
      ctx.inject(['slots', 'remote'], (scope) => {
        scope.effect(async () => {
          let disposeRemote
          try {
            const React = require('react')
            disposeRemote = await scope.remote.$mount({ package: '@lumintian/dsh-model-scope', descriptors: managementDescriptors })
            await scope.inject(['remote.modelScope'], (child) => {
              const controller = createManagementController(child.remote.modelScope, form, t)
              child.effect(() => () => controller.stop(), 'model-scope: management page state')
              child.slots.inject('settings.section', () => child.slots.register({
                name: 'settings.section', id: 'model-scope', order: 15,
                label: () => t('manage.nav'), inject: () => ({ react: React, controller, t }),
              }, ManagementPage))
            })
            return disposeRemote
          } catch (error) {
            try { if (disposeRemote) await disposeRemote() } catch (cleanupError) {
              console.warn('dsh-model-scope: optional management cleanup failed', cleanupError)
            }
            console.warn('dsh-model-scope: optional model management page unavailable', error)
          }
        }, 'model-scope: optional settings page')
      })
    }

    const name = 'dsh-model-scope'
    const inject = ['locale', 'modelDirectories', 'uiSession', 'configForms']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'model-scope: dictionaries')
      const t = ctx.locale.bind(LOCALE_NS)
      const form = ctx.configForms.get(NAMESPACE)
      installManagement(ctx, form, t)

      const sessions = () => ctx.get('sessions')
      const isSubagent = (sessionId) => {
        const service = sessions()
        return service !== undefined && typeof service.subagentAddress === 'function' && service.subagentAddress(sessionId) !== undefined
      }
      const notify = (sessionId, level, text) => {
        try {
          const service = sessions()
          const scope = service && typeof service.scope === 'function' ? service.scope(sessionId) : undefined
          const conversation = scope ? scope.get('conversation') : undefined
          if (conversation) conversation.input.for(scope).notify(level, text)
        } catch { /* feedback is best effort */ }
      }
      const favorites = () => {
        const snapshot = form.getSnapshot()
        if (!snapshot || snapshot.value === undefined) return undefined
        const list = snapshot.value && snapshot.value.favorites
        return Array.isArray(list) ? list : []
      }
      /** Load the session's directory and the favorites it lists. */
      const load = async (sessionId) => {
        const directory = ctx.modelDirectories.directoryFor(sessionId)
        const state = await directory.load()
        const patterns = favorites()
        return { directory, state, choices: patterns === undefined ? undefined : favoriteChoices(state.groups, patterns) }
      }
      const switchTo = async (sessionId, directory, state, choice, index, total) => {
        const result = await directory.select(selectionFor(choice, state.current))
        if (result && result.ok === false) throw result.error
        notify(sessionId, 'info', t('notice.switched', { name: choice.name, index, total }))
      }
      const cycle = async (sessionId, delta) => {
        try {
          if (isSubagent(sessionId)) return notify(sessionId, 'error', t('notice.subagent'))
          const { directory, state, choices } = await load(sessionId)
          if (choices === undefined) return notify(sessionId, 'error', t('notice.loading'))
          const next = step(choices, state.current, delta)
          if (next === undefined) return notify(sessionId, 'error', t('notice.none'))
          if (next.same) return notify(sessionId, 'info', t('notice.only', { name: next.choice.name }))
          await switchTo(sessionId, directory, state, next.choice, next.index + 1, choices.length)
        } catch (error) {
          notify(sessionId, 'error', t('notice.failed', { message: errorText(error) }))
        }
      }
      const onScreen = () => {
        const current = ctx.uiSession.adapter.current.getSnapshot()
        return current && typeof current.key === 'string' ? current.key : undefined
      }

      // Shortcuts. Defaults follow dsh's Web convention (Mod+Alt / three
      // modifiers); Linux Web admits no extra combinations, so it has none.
      ctx.inject(['shortcuts'], (scope) => {
        const shortcuts = scope.get('shortcuts')
        const both = (modifiers) => {
          const binding = { code: 'KeyM', modifiers }
          return {
            'desktop:macos': binding, 'desktop:windows': binding, 'desktop:linux': binding,
            'web:macos': binding, 'web:windows': binding,
          }
        }
        for (const [direction, delta, modifiers] of [['next', 1, ['primary', 'alt']], ['prev', -1, ['primary', 'alt', 'shift']]]) {
          const command = {
            id: `model-scope.favorite.${direction}`,
            label: () => t(`shortcut.${direction}`),
            aliases: ['model', 'favorite', 'cycle', '模型', '收藏', '轮切'],
            defaults: both(modifiers),
            regions: ['page', 'editable'],
            modals: [],
            resolve: () => {
              const sessionId = onScreen()
              if (sessionId === undefined) return { status: 'blocked', reason: t('blocked.noSession') }
              return { status: 'handled', run: () => { void cycle(sessionId, delta) } }
            },
          }
          scope.effect(() => {
            try {
              return shortcuts.register(command)
            } catch (error) {
              // A default another plugin already claims: register unbound, so it can be bound in settings.
              console.warn(`dsh-model-scope: shortcut ${command.id} registered without a default key`, error)
              return shortcuts.register({ ...command, defaults: {} })
            }
          }, `model-scope: ${direction} favorite shortcut`)
        }
      })

      // Slash commands and the /model-scope decoration.
      ctx.inject(['commandUi'], (scope) => {
        const commandUi = scope.get('commandUi')
        const available = session => !isSubagent(session.sessionId)
        scope.effect(() => commandUi.register({
          name: 'fav',
          label: () => 'fav',
          description: () => t('command.fav'),
          available,
          ui: {
            kind: 'popupSelect',
            searchMode: 'fuzzy-label',
            searchLabels: () => ({ placeholder: t('search.placeholder'), empty: t('search.empty'), noResults: t('search.noResults') }),
            options: async (session) => {
              const { state, choices } = await load(session.sessionId)
              return (choices || []).map((choice, index) => ({
                id: `${choice.provider}/${choice.model}`,
                label: choice.name,
                badge: String(index + 1),
                detail: choice.provider === 'deepseek-account' ? t('provider.account') : choice.providerName,
                ...(state.current && state.current.provider === choice.provider && state.current.model === choice.model ? { active: true } : {}),
              }))
            },
            onSelect: async (option, session) => {
              const { directory, state, choices } = await load(session.sessionId)
              const index = (choices || []).findIndex(choice => `${choice.provider}/${choice.model}` === option.id)
              if (index < 0) throw new Error(t('notice.none'))
              await switchTo(session.sessionId, directory, state, choices[index], index + 1, choices.length)
            },
          },
        }), 'model-scope: /fav')
        for (const [direction, delta] of [['next', 1], ['prev', -1]]) {
          scope.effect(() => commandUi.register({
            name: `fav-${direction}`,
            label: () => `fav-${direction}`,
            description: () => t(`command.${direction}`),
            available,
            ui: { kind: 'action', run: (session) => { void cycle(session.sessionId, delta) } },
          }), `model-scope: /fav-${direction}`)
        }
      })

      // A bare pick or Enter on the host /model-scope runs it at once. Reading
      // `remote.commands` requires declaring it, hence its own scope; without
      // it the host command keeps dsh's default (insert the token, wait for arguments).
      ctx.inject(['commandUi', 'remote.commands'], (scope) => {
        const commandUi = scope.get('commandUi')
        const commands = scope.get('remote').commands
        scope.effect(() => commandUi.decorate({
          name: 'model-scope',
          available: () => true,
          ui: {
            kind: 'action',
            run: (session) => {
              void Promise.resolve(commands.execute(session.sessionId, '/model-scope', [])).then((result) => {
                if (result && result.ok === false) notify(session.sessionId, 'error', errorText(result.error))
                else if (result && result.ok && result.value && result.value.result && result.value.result.kind === 'error') {
                  notify(session.sessionId, 'error', String(result.value.result.text || '/model-scope failed'))
                }
              }, error => notify(session.sessionId, 'error', errorText(error)))
            },
          },
        }), 'model-scope: /model-scope runs on a bare pick')
      })
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    /** Pure helpers, exported for tests. */
    exports.internals = {
      parseMatch, favoriteChoices, step, selectionFor, pickerOrder,
      managementDescriptors, managementSnapshot, managementPlan, managementGroups,
      createManagementController, ManagementPage,
    }
    return module.exports
  },
})
