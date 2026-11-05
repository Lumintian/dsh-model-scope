/**
 * Browser half of @lumintian/dsh-model-scope, in dsh's lazy-CJS factory
 * format (see dsh `packages/client/modules`). Hand-written plain JavaScript:
 * it needs no build step and requires no module, only Context services.
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

    const name = 'dsh-model-scope'
    const inject = ['locale', 'modelDirectories', 'uiSession', 'configForms']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'model-scope: dictionaries')
      const t = ctx.locale.bind(LOCALE_NS)
      const form = ctx.configForms.get(NAMESPACE)

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
    exports.internals = { parseMatch, favoriteChoices, step, selectionFor, pickerOrder }
    return module.exports
  },
})
