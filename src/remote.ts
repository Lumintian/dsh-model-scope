/** Read-only management RPC. Actual writes stay on dsh's public configForms path. */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { TypertRemoteService, type InvocationDescriptor, type TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import type { CommandHost, Surface } from './commands.ts'
import { MANAGE_ACTIONS, managedProviders, manageModel, type ManageAction, type ManagedProvider } from './manage.ts'
import { Scope } from './scope.ts'

const PACKAGE = '@lumintian/dsh-model-scope'

export interface ManagementSnapshot {
  providers: ManagedProvider[]
  mode: string
  issues: string[]
  surface: Surface
  revision: number
  writable: boolean
}

export type ManagementPlan = { ok: true; ops: SettingsPathOp[]; revision: number } | { ok: false; error: string }

function codec(typeSymbol: string, parse: (value: unknown) => unknown): TypertCodec {
  return { mode: 'strict', typeSymbol, create: () => ({ parse }) }
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new Error('Expected a non-empty string')
  return value
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Expected a settings revision')
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid model management response')
  return value as Record<string, unknown>
}

/** Hand-written strict schemas are a public Typert extension; no generator/decorators needed. */
export const managementDescriptors: InvocationDescriptor[] = [
  {
    id: `${PACKAGE}#modelScope/snapshot`, service: 'modelScope', namespace: 'modelScope', method: 'snapshot',
    invocation: { kind: 'direct' }, parameters: [],
    result: codec('ManagementSnapshot', (value) => {
      const data = record(value)
      if (!Array.isArray(data.providers) || !Array.isArray(data.issues) || typeof data.writable !== 'boolean') throw new Error('Invalid management snapshot')
      revision(data.revision)
      return value
    }),
  },
  {
    id: `${PACKAGE}#modelScope/plan`, service: 'modelScope', namespace: 'modelScope', method: 'plan',
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'action', wire: 'action', source: 'json', codec: codec('ManageAction', (value) => {
        const action = text(value)
        if (!MANAGE_ACTIONS.includes(action)) throw new Error('Unknown model management action')
        return action
      }) },
      { name: 'provider', wire: 'provider', source: 'json', codec: codec('string', text) },
      { name: 'model', wire: 'model', source: 'json', codec: codec('string', text) },
      { name: 'expectedRevision', wire: 'expectedRevision', source: 'json', codec: codec('number', revision) },
    ],
    result: codec('ManagementPlan', (value) => {
      const data = record(value)
      if (data.ok === true && Array.isArray(data.ops)) revision(data.revision)
      else if (data.ok !== false || typeof data.error !== 'string') throw new Error('Invalid management plan')
      return value
    }),
  },
]

interface ManagementOptions {
  host: CommandHost
  namespace: string
}

export class ModelScopeRemote extends TypertRemoteService {
  static inject = ['settings']
  private readonly options: ManagementOptions

  constructor(ctx: Context, options: ManagementOptions) {
    super(ctx, 'modelScope')
    this.options = options
  }

  private descriptor() {
    const descriptor = this.ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === this.options.namespace)
    if (descriptor === undefined) throw new Error('模型范围配置尚未就绪')
    return descriptor
  }

  async snapshot(): Promise<ManagementSnapshot> {
    const providers = await this.options.host.catalog()
    const descriptor = this.descriptor()
    const settings = this.options.host.read()
    return {
      providers: managedProviders(providers, settings, this.options.host.defaultModel()),
      mode: settings.mode, issues: new Scope(settings).issues, surface: this.options.host.surface(),
      revision: descriptor.revision, writable: this.ctx.settings.writable,
    }
  }

  async plan(action: ManageAction, provider: string, model: string, expectedRevision: number): Promise<ManagementPlan> {
    try {
      if (!MANAGE_ACTIONS.includes(action)) throw new Error('不支持这个模型管理操作')
      if (!this.ctx.settings.writable) throw new Error('当前 profile 不允许修改配置')
      const providers = await this.options.host.catalog()
      const descriptor = this.descriptor()
      if (descriptor.revision !== expectedRevision) throw new Error('配置已被其他页面修改，请刷新后重试')
      const patch = manageModel(this.options.host.read(), providers, { provider, model }, action, this.options.host.defaultModel())
      const ops: SettingsPathOp[] = Object.entries(patch).map(([key, value]) => ({ op: 'set', path: [key], value }))
      return { ok: true, ops, revision: descriptor.revision }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '无法生成模型管理操作，请刷新后重试' }
    }
  }
}

/** Host registration capability is intentionally absent from the protocol's read-only registry face. */
interface HostRegistry {
  register(contribution: {
    package: string; face: 'host'; schemas: never[]
    model: { services: never[]; events: never[]; objects: never[] }
    invocations: InvocationDescriptor[]
  }): () => Promise<void>
}

export function registerManagement(ctx: Context, host: CommandHost, namespace: string): void {
  ctx.inject(['typert', 'settings'], (child) => {
    const registry = child.typert as typeof child.typert & HostRegistry
    if (typeof registry.register !== 'function') {
      child.logger.warn('dsh-model-scope: management registry is unavailable; commands remain usable')
      return
    }
    child.plugin(ModelScopeRemote, { host, namespace })
    child.effect(() => {
      try {
        return registry.register({
          package: PACKAGE, face: 'host', schemas: [], model: { services: [], events: [], objects: [] },
          invocations: managementDescriptors,
        })
      } catch (error) {
        child.logger.warn('dsh-model-scope: management registration failed; commands remain usable')
        child.logger.warn(error)
        return () => {}
      }
    })
  })
}
