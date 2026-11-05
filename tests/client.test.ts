/**
 * The browser half, loaded the way dsh's client module system loads it: the
 * script registers a factory on `window.__ModuleLoader__`, and the factory's
 * exports are a client plugin. Services are scripted stand-ins with the shapes
 * the real ones have in dsh 0.2.1-rc.5.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

interface Registered {
  id: string
  factory: (require: (id: string) => unknown) => ClientModule
}

interface ClientModule {
  name: string
  inject: string[]
  apply(ctx: unknown): void
  internals: {
    favoriteChoices(groups: unknown[], patterns: string[]): Array<{ provider: string; model: string; name: string }>
    step(choices: unknown[], current: unknown, delta: number): { choice: { model: string }; index: number; same: boolean } | undefined
  }
}

function loadClient(): { id: string; module: ClientModule } {
  let registered: Registered | undefined
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  // Same realm as the assertions, so arrays and objects compare structurally.
  const run = new Function('window', source) as (window: unknown) => void
  run({ __ModuleLoader__: { load: (entry: Registered) => { registered = entry } } })
  assert.ok(registered, 'the script registers itself')
  const module = registered.factory(() => { throw new Error('client.js must not require anything') })
  return { id: registered.id, module }
}

const GROUPS = [
  { id: 'cpa-home', name: '家用 CPA', models: [
    { id: 'gpt-5.4', name: 'GPT-5.4' },
    { id: 'gpt-5.5', name: '★ GPT-5.5', reasoning: { efforts: [], defaultEffort: 'high' } },
    { id: 'gpt-6-luna', name: '★ GPT-6-LUNA' },
  ] },
  { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'Chat' }] },
  { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'claude-x', name: '★ Claude X' }] },
]

test('the script registers under the package name and requires nothing', () => {
  const { id, module } = loadClient()
  assert.equal(id, '@lumintian/dsh-model-scope')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }
  assert.equal(id, manifest.name)
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['locale', 'modelDirectories', 'uiSession', 'configForms'])
})

test('favorites expand in favorites order, picker order within a pattern, without repeats; stars are stripped', () => {
  const { internals } = loadClient().module
  const choices = internals.favoriteChoices(GROUPS, ['openrouter/*', 'gpt-*', 'cpa-home/gpt-5.5', 'deepseek-*', '/(/'])
  assert.deepEqual(choices.map(c => `${c.provider}/${c.model}`), [
    'openrouter/claude-x', 'cpa-home/gpt-5.4', 'cpa-home/gpt-5.5', 'cpa-home/gpt-6-luna', 'deepseek-official/deepseek-chat',
  ])
  assert.equal(choices[0]!.name, 'Claude X')
  // dsh pins the DeepSeek groups first, so a wildcard expands them first too.
  assert.deepEqual(internals.favoriteChoices(GROUPS, ['*']).map(c => c.provider)[0], 'deepseek-official')
})

test('step wraps around and starts from the ends when the current model is no favorite', () => {
  const { internals } = loadClient().module
  const choices = internals.favoriteChoices(GROUPS, ['cpa-home/gpt-5.5', 'openrouter/claude-x', 'cpa-home/gpt-6-luna'])
  const at = (model: string) => ({ provider: model === 'claude-x' ? 'openrouter' : 'cpa-home', model })
  assert.equal(internals.step(choices, at('gpt-5.5'), 1)!.choice.model, 'claude-x')
  assert.equal(internals.step(choices, at('gpt-6-luna'), 1)!.choice.model, 'gpt-5.5')
  assert.equal(internals.step(choices, at('gpt-5.5'), -1)!.choice.model, 'gpt-6-luna')
  assert.equal(internals.step(choices, at('gpt-5.4'), 1)!.choice.model, 'gpt-5.5')
  assert.equal(internals.step(choices, at('gpt-5.4'), -1)!.choice.model, 'gpt-6-luna')
  assert.equal(internals.step([], at('gpt-5.4'), 1), undefined)
  assert.equal(internals.step(choices.slice(0, 1), at('gpt-5.5'), 1)!.same, true)
})

/** A client Context stand-in with the services the plugin uses. */
function harness(favorites: string[] | undefined, current = { provider: 'cpa-home', model: 'gpt-5.4' }) {
  const shortcuts = new Map<string, { defaults: Record<string, unknown>; resolve(): { status: string; run?: () => void; reason?: string } }>()
  const contributions = new Map<string, { ui: { kind: string; run?: (s: unknown) => void; options?: (s: unknown) => Promise<unknown[]>; onSelect?: (o: unknown, s: unknown) => Promise<void> } }>()
  const decorations = new Map<string, { ui: { kind: string; run(s: unknown): void } }>()
  const selected: unknown[] = []
  const notices: Array<[string, string]> = []
  const executed: string[] = []
  let state = { current: { ...current, reasoningEffort: 'low' }, groups: GROUPS }
  const services: Record<string, unknown> = {
    locale: {
      register: () => () => {},
      bind: () => (key: string, params?: Record<string, unknown>) => `${key}${params ? JSON.stringify(params) : ''}`,
    },
    configForms: { get: (ns: string) => {
      assert.equal(ns, 'model-scope')
      return { getSnapshot: () => ({ value: favorites === undefined ? undefined : { favorites } }) }
    } },
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: 'session-1' }) } } },
    modelDirectories: { directoryFor: (id: string) => {
      assert.equal(id, 'session-1')
      return {
        load: async () => state,
        select: async (selection: { provider: string; model: string }) => {
          selected.push(selection)
          state = { ...state, current: { ...selection, reasoningEffort: 'low' } }
          return { ok: true }
        },
      }
    } },
    sessions: {
      subagentAddress: () => undefined,
      scope: () => ({ get: () => ({ input: { for: () => ({ notify: (level: string, text: string) => { notices.push([level, text]) } }) } }) }),
    },
    shortcuts: { register: (command: { id: string; defaults: Record<string, unknown>; resolve(): { status: string } }) => {
      shortcuts.set(command.id, command as never)
      return () => { shortcuts.delete(command.id) }
    } },
    commandUi: {
      register: (contribution: { name: string }) => { contributions.set(contribution.name, contribution as never); return () => {} },
      decorate: (decoration: { name: string }) => { decorations.set(decoration.name, decoration as never); return () => {} },
    },
    remote: { commands: { execute: async (_id: string, line: string) => { executed.push(line); return { ok: true, value: { result: { kind: 'success' } } } } } },
  }
  // dsh resolves `remote.<namespace>` as its own injectable service.
  services['remote.commands'] = (services['remote'] as { commands: unknown }).commands
  const ctx = {
    get: (name: string) => services[name],
    effect: (fn: () => unknown) => { fn() },
    inject: (deps: string[], fn: (scope: unknown) => void) => { if (deps.every(dep => services[dep] !== undefined)) fn(ctx) },
    ...services,
  }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  return { ctx, shortcuts, contributions, decorations, selected, notices, executed, settle, state: () => state }
}

test('the next-favorite shortcut switches the on-screen session and says so', async () => {
  const { module } = loadClient()
  const app = harness(['cpa-home/gpt-5.5', 'openrouter/claude-x'])
  module.apply(app.ctx)
  const next = app.shortcuts.get('model-scope.favorite.next')!
  assert.deepEqual(next.defaults['web:windows'], { code: 'KeyM', modifiers: ['primary', 'alt'] })
  assert.equal(next.defaults['web:linux'], undefined, 'Linux Web admits no extra combinations')
  assert.deepEqual((app.shortcuts.get('model-scope.favorite.prev')!.defaults['web:macos'] as { modifiers: string[] }).modifiers, ['primary', 'alt', 'shift'])

  next.resolve().run!()
  await app.settle()
  assert.deepEqual(app.selected.at(-1), { provider: 'cpa-home', model: 'gpt-5.5', reasoningEffort: 'high' }, 'a new route takes its default effort')
  assert.deepEqual(app.notices.at(-1), ['info', 'notice.switched{"name":"GPT-5.5","index":1,"total":2}'])

  next.resolve().run!()
  await app.settle()
  assert.deepEqual(app.selected.at(-1), { provider: 'openrouter', model: 'claude-x' })

  app.shortcuts.get('model-scope.favorite.prev')!.resolve().run!()
  await app.settle()
  assert.deepEqual(app.selected.at(-1), { provider: 'cpa-home', model: 'gpt-5.5', reasoningEffort: 'high' })
})

test('without favorites, or while they load, the shortcut explains instead of switching', async () => {
  const { module } = loadClient()
  for (const [favorites, notice] of [[[], 'notice.none'], [undefined, 'notice.loading'], [['cpa-home/gone'], 'notice.none']] as const) {
    const app = harness(favorites as string[] | undefined)
    module.apply(app.ctx)
    app.shortcuts.get('model-scope.favorite.next')!.resolve().run!()
    await app.settle()
    assert.deepEqual(app.selected, [])
    assert.deepEqual(app.notices.at(-1), ['error', notice])
  }
  const single = harness(['cpa-home/gpt-5.4'])
  module.apply(single.ctx)
  single.shortcuts.get('model-scope.favorite.next')!.resolve().run!()
  await single.settle()
  assert.deepEqual(single.selected, [])
  assert.equal(single.notices.at(-1)![0], 'info')
})

test('/fav lists favorites with the current one active; /fav-next cycles; /model-scope runs on a bare pick', async () => {
  const { module } = loadClient()
  const app = harness(['openrouter/claude-x', 'cpa-home/gpt-5.4'])
  module.apply(app.ctx)
  const session = { sessionId: 'session-1' }
  const fav = app.contributions.get('fav')!.ui
  assert.equal(fav.kind, 'popupSelect')
  const options = await fav.options!(session) as Array<{ id: string; label: string; badge: string; detail: string; active?: boolean }>
  assert.deepEqual(options.map(o => [o.id, o.label, o.badge, o.detail, o.active === true]), [
    ['openrouter/claude-x', 'Claude X', '1', 'OpenRouter', false],
    ['cpa-home/gpt-5.4', 'GPT-5.4', '2', '家用 CPA', true],
  ])
  await fav.onSelect!(options[0], session)
  assert.deepEqual(app.selected.at(-1), { provider: 'openrouter', model: 'claude-x' })

  app.contributions.get('fav-next')!.ui.run!(session)
  await app.settle()
  assert.deepEqual(app.selected.at(-1), { provider: 'cpa-home', model: 'gpt-5.4' })

  app.decorations.get('model-scope')!.ui.run(session)
  await app.settle()
  assert.deepEqual(app.executed, ['/model-scope'])
})
