import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { DEFAULT_SETTINGS } from '../src/config.ts'
import { managementDescriptors, ModelScopeRemote } from '../src/remote.ts'
import { manageModel, managedProviders } from '../src/manage.ts'
import { Scope } from '../src/scope.ts'

const providers = [{ id: 'alpha', name: 'Alpha', models: [
  { id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }, { id: 'a3', name: 'A3' },
] }]
const ref = { provider: 'alpha', model: 'a2' }

test('management reuses exact hide/show and favorites without mutating the input; hidden models remain manageable', () => {
  const before = structuredClone(DEFAULT_SETTINGS)
  const favorite = { ...before, ...manageModel(before, providers, ref, 'favorite') }
  assert.deepEqual(favorite.favorites, ['alpha/a2'])
  assert.deepEqual(manageModel(favorite, providers, ref, 'unfavorite'), { favorites: [] })
  const hidden = { ...favorite, ...manageModel(favorite, providers, ref, 'hide') }
  const rows = managedProviders(providers, hidden)[0]!.models
  assert.deepEqual(rows.map(model => model.id), ['a1', 'a3', 'a2'])
  assert.equal(rows[2]!.visible, false)
  assert.equal(rows[2]!.favorite, true)
  assert.match(rows[2]!.reason, /alpha\/a2/)
  assert.deepEqual(manageModel(hidden, providers, ref, 'show'), { exclude: [] })
  assert.deepEqual(before, DEFAULT_SETTINGS)
})

test('broad user rules are never deleted by per-model actions and stale models are rejected', () => {
  assert.throws(() => manageModel({ ...DEFAULT_SETTINGS, exclude: ['alpha/*'] }, providers, ref, 'show'), /alpha\/\*/)
  assert.throws(() => manageModel({ ...DEFAULT_SETTINGS, favorites: ['alpha/*', 'alpha/a2'] }, providers, ref, 'unfavorite'), /alpha\/\*/)
  assert.throws(() => manageModel(DEFAULT_SETTINGS, providers, { ...ref, model: 'gone' }, 'hide'), /刷新/)
})

test('group moves preserve whitelist visibility, broad rules, hidden entries and the protected default', () => {
  const settings = { ...DEFAULT_SETTINGS, mode: 'include' as const, include: ['alpha/a2', 'alpha/a1', 'missing/*'], favorites: ['alpha/*'] }
  const fallback = { provider: 'alpha', model: 'a3' }
  const patch = manageModel(settings, providers, ref, 'down', fallback)
  const after = { ...settings, ...patch }
  assert.deepEqual(after.include, ['alpha/a1', 'alpha/a2', 'missing/*'])
  assert.deepEqual(new Scope(after).orderModels('alpha', providers[0]!.models, model => model.id).map(model => model.id), ['a1', 'a2'])
  assert.deepEqual(after.favorites, settings.favorites, 'list order never changes cycle order')
  const protectedRow = managedProviders(providers, after, fallback)[0]!.models.find(model => model.id === 'a3')!
  assert.equal(protectedRow.visible, true)
  assert.equal(protectedRow.ruleHidden, true)
  assert.equal(protectedRow.up, false)
  assert.equal(protectedRow.down, false)
  assert.throws(() => manageModel(after, providers, fallback, 'top', fallback), /恢复显示/)
  const broad = { ...DEFAULT_SETTINGS, include: ['alpha/*'], exclude: ['alpha/a3'] }
  const reordered = { ...broad, ...manageModel(broad, providers, ref, 'up') }
  assert.deepEqual(reordered.include, ['alpha/a2', 'alpha/a1', 'alpha/*'])
  assert.deepEqual(reordered.exclude, broad.exclude)
  assert.deepEqual(manageModel(reordered, providers, ref, 'up'), {})
})

test('management RPC only plans fenced writes; stale revisions and read-only profiles are refused', async () => {
  const ctx = new Context()
  let writable = true
  ctx.provide('settings', {
    get writable() { return writable },
    describe: () => [{ ns: 'model-scope', revision: 7 }],
    mutate: () => { throw new Error('management RPC must never write configuration') },
  } as never)
  const fiber = ctx.plugin(ModelScopeRemote, { namespace: 'model-scope', host: {
    read: () => DEFAULT_SETTINGS,
    write: async () => { throw new Error('management RPC must never write configuration') },
    catalog: async () => providers,
    defaultModel: () => undefined,
    surface: () => 'web',
  } })
  await fiber
  try {
    const remote = ctx.get('modelScope') as ModelScopeRemote
    const snapshot = await remote.snapshot()
    assert.equal(snapshot.revision, 7)
    assert.equal(snapshot.providers[0]!.models.length, 3)
    assert.deepEqual(await remote.plan('hide', 'alpha', 'a2', 7), {
      ok: true, revision: 7, ops: [{ op: 'set', path: ['exclude'], value: ['alpha/a2'] }],
    })
    assert.match(JSON.stringify(await remote.plan('hide', 'alpha', 'a2', 6)), /其他页面/)
    writable = false
    assert.match(JSON.stringify(await remote.plan('hide', 'alpha', 'a2', 7)), /不允许/)
    const parameter = managementDescriptors[1]!.parameters[3]!.codec
    assert.equal(parameter.mode, 'strict')
    if (parameter.mode === 'strict') assert.throws(() => parameter.create().parse('7'), /revision/)
  } finally {
    await fiber.dispose()
  }
})
