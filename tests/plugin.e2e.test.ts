/**
 * End to end: the plugin mounted through Cordis' Loader beside the real dsh
 * LLM runtime with scripted adapters.
 *
 * - Web profile: a stand-in session controller service exposes
 *   `modelCatalog()` built from the live registry, like dsh's own. Only that
 *   catalog is filtered; `llm.listModels` stays complete.
 * - Other profiles (no session controller): `llm.listModels` and
 *   `llm.listProviders` are filtered and ordered.
 * - Config changes re-announce `llm/adapters-updated`; disposing restores
 *   every patched method.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime, { LlmAdapter, type LlmModelInfo, type LlmProviderInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'

const MODELS: Record<string, string[]> = {
  alpha: ['a1', 'a2', 'a3'],
  beta: ['b1', 'b2'],
  gamma: ['g1'],
}

class ScriptedAdapter extends LlmAdapter {
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider.toUpperCase() } as LlmProviderInfo
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return (MODELS[provider] ?? []).map(id => ({ provider, id, name: id.toUpperCase() }))
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    // Never called in these tests.
  }
}

interface Catalog {
  default: { provider: string; model: string }
  routableProviders: string[]
  groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
  failures: unknown[]
}

/** Minimal stand-in for dsh's session controller: the same projection `buildModelCatalog` makes. */
class FakeSessionController extends Service {
  static readonly inject = ['llm']
  seenInvocation: unknown[] = []

  constructor(ctx: Context) {
    super(ctx, 'sessionController')
  }

  async modelCatalog(): Promise<Catalog> {
    // dsh's gateway calls through a Context carrying the invocation; the original must still see it.
    this.seenInvocation.push(Reflect.get(this.ctx, 'invocation'))
    const llm = this.ctx.get('llm')!
    const groups = await Promise.all(llm.listProviders().map(async (provider) => ({
      id: provider.id,
      name: provider.name,
      models: (await llm.listModels(provider.id)).map(model => ({ id: model.id, name: model.name })),
    })))
    return {
      default: { provider: 'gamma', model: 'g1' },
      routableProviders: groups.map(group => group.id),
      groups: groups.filter(group => group.models.length > 0),
      failures: [],
    }
  }
}

const shape = (catalog: Catalog): string[][] => catalog.groups.map(group => [group.id, ...group.models.map(model => model.id)])

async function boot(options: { web: boolean; config: Record<string, unknown> }) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['alpha', 'beta', 'gamma'], new ScriptedAdapter())
  if (options.web) await ctx.plugin(FakeSessionController)
  let announcements = 0
  ctx.on('llm/adapters-updated', () => { announcements++ })
  const commands = new Map<string, { handler: (invocation: unknown) => Promise<{ kind: string; text?: string }> }>()
  ctx.provide('commands', {
    register: (definition: { name: string; handler: (invocation: unknown) => Promise<{ kind: string; text?: string }> }) => {
      commands.set(definition.name, definition)
      return () => { commands.delete(definition.name) }
    },
  } as never)
  await ctx.plugin(Loader)
  ctx.loader.builtins['scope-under-test'] = plugin
  const id = await ctx.loader.create({ id: 'model-scope', name: 'cordis:scope-under-test', config: options.config } as { name: string; config: unknown })
  const entry = ctx.loader.resolve(id)
  await entry.fiber!.await()
  const update = async (next: Record<string, unknown>) => {
    await entry.update({ config: next })
    await entry.fiber!.await()
  }
  const writes: Array<Array<{ path: string[]; value: unknown }>> = []
  ctx.provide('settings', {
    mutate: async (_ns: string, ops: Array<{ op: 'set'; path: string[]; value: unknown }>) => {
      writes.push(ops)
      const next = structuredClone(entry.options.config as Record<string, unknown>)
      for (const op of ops) next[op.path[0]!] = op.value
      await update(next)
    },
  } as never)
  const run = async (name: string, rawInput = '') => {
    const command = commands.get(name)
    assert.ok(command, `command /${name} is registered`)
    return await command.handler({ rawInput, agent: { session: { requestContext: () => undefined } } })
  }
  /** Call the catalog the way dsh's RPC gateway does: through a Context extended with the call. */
  const catalog = async (): Promise<Catalog> => {
    const invocation = { method: 'modelCatalog' }
    const receiver = ctx.extend({ invocation } as never).get('sessionController') as unknown as FakeSessionController
    const method = Reflect.get(receiver, 'modelCatalog') as () => Promise<Catalog>
    return await Reflect.apply(method, receiver, [])
  }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  return { ctx, entry, update, run, catalog, writes, settle, announcements: () => announcements, commands }
}

test('web profile: only the browser catalog is filtered and ordered', async () => {
  const app = await boot({ web: true, config: { exclude: ['a2'], include: ['beta/b2', 'g*'] } })
  assert.deepEqual(shape(await app.catalog()), [['beta', 'b2', 'b1'], ['gamma', 'g1'], ['alpha', 'a1', 'a3']])

  const controller = app.ctx.get('sessionController') as unknown as FakeSessionController
  assert.deepEqual(controller.seenInvocation.at(-1), { method: 'modelCatalog' }, 'the original still sees the call context')

  // Sending, subagents and server-side checks read the registry: unchanged.
  assert.deepEqual((await app.ctx.llm.listModels('alpha')).map(model => model.id), ['a1', 'a2', 'a3'])
  assert.deepEqual(app.ctx.llm.listProviders().map(provider => provider.id), ['alpha', 'beta', 'gamma'])
})

test('web profile: config changes re-announce the catalog; disposing restores it', async () => {
  const app = await boot({ web: true, config: {} })
  assert.deepEqual(shape(await app.catalog()), [['alpha', 'a1', 'a2', 'a3'], ['beta', 'b1', 'b2'], ['gamma', 'g1']])

  const before = app.announcements()
  await app.update({ mode: 'include', include: ['alpha/a3', 'b*'] })
  assert.equal(app.announcements(), before + 1, 'a volatile change announces llm/adapters-updated once')
  // gamma/g1 is the default model, kept by keepDefault.
  assert.deepEqual(shape(await app.catalog()), [['alpha', 'a3'], ['beta', 'b1', 'b2'], ['gamma', 'g1']])

  await app.update({ mode: 'include', include: ['alpha/a3', 'b*'], keepDefault: false })
  assert.deepEqual(shape(await app.catalog()), [['alpha', 'a3'], ['beta', 'b1', 'b2']])

  const unchanged = app.announcements()
  await app.update({ mode: 'include', include: ['alpha/a3', 'b*'], keepDefault: false })
  assert.equal(app.announcements(), unchanged, 'an identical config does not announce')

  const raw = app.ctx.get('sessionController') as unknown as Record<symbol, object>
  const instance = raw[Symbol.for('cordis.original')]!
  assert.ok(Object.hasOwn(instance, 'modelCatalog'), 'patched on the instance')
  const beforeDispose = app.announcements()
  await app.entry.update({ disabled: true })
  await app.settle()
  assert.ok(!Object.hasOwn(instance, 'modelCatalog'), 'the instance is back to its prototype method')
  assert.ok(app.announcements() > beforeDispose, 'disposing announces so pickers show everything again')
  assert.deepEqual(shape(await app.catalog()), [['alpha', 'a1', 'a2', 'a3'], ['beta', 'b1', 'b2'], ['gamma', 'g1']])
  assert.ok(!Object.hasOwn(app.ctx.llm[Symbol.for('cordis.original') as never] as object, 'listModels'))
})

test('web profile: a session controller that comes later is patched too', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['alpha', 'beta'], new ScriptedAdapter())
  await ctx.plugin(Loader)
  ctx.loader.builtins['scope-under-test'] = plugin
  const id = await ctx.loader.create({ id: 'model-scope', name: 'cordis:scope-under-test', config: { exclude: ['alpha/*'] } } as { name: string; config: unknown })
  await ctx.loader.resolve(id).fiber!.await()
  const fiber = ctx.plugin(FakeSessionController)
  await fiber
  await new Promise(resolve => setImmediate(resolve))
  const controller = ctx.get('sessionController') as unknown as FakeSessionController
  assert.deepEqual(shape(await controller.modelCatalog()), [['beta', 'b1', 'b2']])
  // Before the controller existed, the registry was filtered (ACP-style); now it is complete again.
  assert.deepEqual((await ctx.llm.listModels('alpha')).map(model => model.id), ['a1', 'a2', 'a3'])
  await fiber.dispose()
  assert.deepEqual((await ctx.llm.listModels('alpha')).map(model => model.id), [], 'without a controller the registry is filtered again')
})

test('other profiles: llm.listModels and llm.listProviders are filtered and ordered', async () => {
  const app = await boot({ web: false, config: { exclude: ['a2'], include: ['beta/b2', 'gamma/*'] } })
  await app.settle()
  assert.deepEqual((await app.ctx.llm.listModels('alpha')).map(model => model.id), ['a1', 'a3'])
  assert.deepEqual((await app.ctx.llm.listModels('beta')).map(model => model.id), ['b2', 'b1'])
  assert.deepEqual(app.ctx.llm.listProviders().map(provider => provider.id), ['beta', 'gamma', 'alpha'])

  await app.update({ exclude: ['a2'], include: ['beta/b2', 'gamma/*'], providerOrder: ['alpha'] })
  assert.deepEqual(app.ctx.llm.listProviders().map(provider => provider.id), ['alpha', 'beta', 'gamma'])

  await app.entry.update({ disabled: true })
  assert.deepEqual((await app.ctx.llm.listModels('alpha')).map(model => model.id), ['a1', 'a2', 'a3'])
  assert.deepEqual(app.ctx.llm.listProviders().map(provider => provider.id), ['alpha', 'beta', 'gamma'])
})

test('commands write the plugin section and the result shows up in the catalog', async () => {
  const app = await boot({ web: true, config: {} })
  let result = await app.run('model-scope', 'hide alpha/a1 */b1')
  assert.equal(result.kind, 'success')
  assert.deepEqual(app.writes.at(-1), [{ op: 'set', path: ['exclude'], value: ['alpha/a1', '*/b1'] }])
  assert.deepEqual(shape(await app.catalog()), [['alpha', 'a2', 'a3'], ['beta', 'b2'], ['gamma', 'g1']])

  result = await app.run('model-scope', 'top beta/b2')
  assert.equal(result.kind, 'success')
  assert.deepEqual(shape(await app.catalog()), [['beta', 'b2'], ['alpha', 'a2', 'a3'], ['gamma', 'g1']])

  result = await app.run('model-scope', 'status')
  assert.match(result.text!.split('\n')[0]!, /^模型范围：all 模式 · 显示 4\/6 个模型 · 优先级 1 条 · 作用于 Web 模型选择器$/)

  // No user-questions service here: the menu falls back to the status text plus usage.
  result = await app.run('model-scope')
  assert.equal(result.kind, 'success')
  assert.match(result.text!, /这个界面不能弹出卡片/)

  result = await app.run('model-scope', 'reset')
  assert.deepEqual(shape(await app.catalog()), [['alpha', 'a1', 'a2', 'a3'], ['beta', 'b1', 'b2'], ['gamma', 'g1']])
})
