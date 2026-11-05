/**
 * DeepSeek Harness plugin: choose which models the model lists show and in
 * what order, across every provider.
 *
 * ```yaml
 * - id: model-scope
 *   config:
 *     mode: all
 *     include:
 *       - 'cpa-home/gpt-5.5'
 *       - 'cpa-home/gpt-6-*'
 *     exclude:
 *       - '*\/gpt-image-*'
 *     providerOrder: [cpa-home, openrouter]
 * ```
 *
 * Where it applies depends on the profile it is installed in:
 *
 * - Web / desktop (the profile has dsh's session controller): only the model
 *   catalog served to the browser (`session/modelCatalog`) is filtered. That is
 *   what the model picker, the Models settings page and the subagent model card
 *   read. Hidden models stay usable; sending, subagents and server-side checks
 *   see the full list.
 * - Any other profile (ACP, headless, SDK): `llm.listModels` and
 *   `llm.listProviders` are filtered and ordered, which is what the ACP model
 *   menu reads. ACP keeps the session's current model listed by itself.
 *
 * @module @lumintian/dsh-model-scope
 */

import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-llm'

import type { Context, VolatileSnapshot } from '@deepseek-ai/cordis'
import { askVia } from './ask.ts'
import { type CommandHost, createCommands, type ProviderModels, type Surface } from './commands.ts'
import { Config, isMode, type ScopeSettings } from './config.ts'
import { type AnyMethod, patchMethod } from './patch.ts'
import { defaultOf, type ModelRef, Scope, scopeCatalog } from './scope.ts'
import { registerManagement } from './remote.ts'

export { Config } from './config.ts'
export type { Mode, ScopeSettings } from './config.ts'

export const name = 'dsh-model-scope'
export const inject = ['llm']

interface IdLike {
  id: string
  name?: string
}

function isIdList(value: unknown): value is IdLike[] {
  return Array.isArray(value) && value.every(item => typeof item === 'object' && item !== null
    && typeof (item as { id?: unknown }).id === 'string')
}

function plainList(value: VolatileSnapshot<string[]> | undefined): string[] {
  return (value ?? []).filter((item): item is string => typeof item === 'string')
}

export function apply(ctx: Context, config: Config): void {
  const settingsNs = ctx.fiber.entry?.options.id ?? name

  const readSettings = (): ScopeSettings => {
    const mode = config.mode.get()
    return {
      mode: isMode(mode) ? mode : 'all',
      include: plainList(config.include.get()),
      exclude: plainList(config.exclude.get()),
      providerOrder: plainList(config.providerOrder.get()),
      keepDefault: config.keepDefault.get() !== false,
      favorites: plainList(config.favorites.get()),
      markFavorites: config.markFavorites.get() !== false,
    }
  }

  let scope = new Scope(readSettings())
  const reportIssues = (): void => {
    for (const issue of scope.issues) ctx.logger.warn(`dsh-model-scope: ignoring invalid pattern ${issue}`)
  }
  reportIssues()

  /** Ask every model list (picker, settings pages, ACP) to reload. */
  const notify = (): void => {
    try {
      ctx.emit('llm/adapters-updated')
    } catch (error) {
      ctx.logger.warn('dsh-model-scope: a model list refresh listener failed')
      ctx.logger.warn(error)
    }
  }

  const isWeb = (): boolean => ctx.get('sessionController') !== undefined

  const defaultModel = (): ModelRef | undefined => {
    try {
      const service = ctx.get('agentDefaultModel') as { currentSelection?: () => unknown } | undefined
      const selection = service?.currentSelection?.()
      return selection === undefined ? undefined : defaultOf({ default: selection })
    } catch {
      return undefined
    }
  }

  // ── Web / desktop: the browser model catalog ────────────────────────────
  let webPatched = false
  ctx.inject(['sessionController'], (child) => {
    child.effect(() => {
      const result = patchMethod(child.get('sessionController') as object, 'modelCatalog', (original, receiver, args) =>
        Promise.resolve(Reflect.apply(original, receiver, args)).then((catalog) => {
          try {
            return scopeCatalog(catalog, scope)
          } catch (error) {
            ctx.logger.warn('dsh-model-scope: filtering the model catalog failed; showing it unfiltered')
            ctx.logger.warn(error)
            return catalog
          }
        }))
      if (!result.ok) {
        ctx.logger.warn(`dsh-model-scope: this dsh version is not supported (${result.reason}); the model picker is left unfiltered`)
        return () => {}
      }
      webPatched = true
      notify()
      return () => {
        webPatched = false
        result.restore()
        notify()
      }
    })
  })

  // ── Other profiles (ACP): the LLM registry's model lists ────────────────
  /** Last full model id list per provider, for ordering providers synchronously. */
  const modelCache = new Map<string, string[]>()
  let originalListModels: AnyMethod | undefined
  let llmPatched = false

  const visibleCached = (provider: string): string[] | undefined => {
    const fallback = defaultModel()
    return modelCache.get(provider)?.filter(model => scope.isVisible({ provider, model },
      fallback?.provider === provider && fallback.model === model))
  }

  ctx.effect(() => {
    const restores: Array<() => void> = []
    const models = patchMethod(ctx.llm, 'listModels', (original, receiver, args) => {
      const pending = Reflect.apply(original, receiver, args)
      if (isWeb()) return pending
      const provider = args[0]
      return Promise.resolve(pending).then((list) => {
        if (typeof provider !== 'string' || !isIdList(list)) return list
        modelCache.set(provider, list.map(model => model.id))
        if (scope.isIdentity) return list
        try {
          return scope.orderModels(provider, list, model => model.id, defaultModel())
        } catch (error) {
          ctx.logger.warn(error)
          return list
        }
      })
    })
    if (models.ok) {
      originalListModels = models.original
      restores.push(models.restore)
      const providers = patchMethod(ctx.llm, 'listProviders', (original, receiver, args) => {
        const list = Reflect.apply(original, receiver, args)
        if (isWeb() || scope.isIdentity || !isIdList(list)) return list
        try {
          return scope.orderProviders(list, provider => provider.id, visibleCached)
        } catch (error) {
          ctx.logger.warn(error)
          return list
        }
      })
      if (providers.ok) restores.push(providers.restore)
      llmPatched = true
    } else {
      ctx.logger.warn(`dsh-model-scope: this dsh version is not supported (${models.reason}); model lists are left unfiltered`)
    }
    return () => {
      llmPatched = false
      originalListModels = undefined
      for (const restore of restores.reverse()) restore()
    }
  })

  /** Learn every provider's model ids so providers can be ordered before ACP asks for their models. */
  const prefetch = (): void => {
    if (isWeb() || !llmPatched) return
    for (const provider of ctx.llm.listProviders()) void ctx.llm.listModels(provider.id).catch(() => {})
  }
  queueMicrotask(prefetch)
  ctx.on('llm/adapters-updated', () => { queueMicrotask(prefetch) })

  ctx.on('loader/volatile-update', () => {
    const next = readSettings()
    if (JSON.stringify(next) === JSON.stringify(scope.settings)) return
    scope = new Scope(next)
    reportIssues()
    notify()
  })

  // ── Commands ─────────────────────────────────────────────────────────────
  const unfilteredModels = async (provider: string): Promise<IdLike[]> => {
    const list: unknown = originalListModels !== undefined
      ? await Reflect.apply(originalListModels, ctx.llm, [provider])
      : await ctx.llm.listModels(provider)
    return isIdList(list) ? list : []
  }

  const surface = (): Surface => (webPatched ? 'web' : llmPatched && !isWeb() ? 'models' : 'none')

  const host: CommandHost = {
    read: () => scope.settings,
    write: async (patch) => {
      const settings = ctx.get('settings')
      if (settings === undefined) {
        throw new Error(`当前组合没有设置服务，请直接编辑 profile 的 cordis.patch.yml 中 id 为 ${settingsNs} 的条目`)
      }
      const ops = (Object.keys(patch) as Array<keyof ScopeSettings>)
        .filter(key => patch[key] !== undefined)
        .map(key => ({ op: 'set' as const, path: [key], value: patch[key] }))
      if (ops.length > 0) await settings.mutate(settingsNs, ops)
    },
    catalog: async () => {
      const providers = ctx.llm.listProviders()
      const fallbackOrder = new Map(providers.map((provider, index) => [provider.id, index]))
      const result: ProviderModels[] = await Promise.all(providers.map(async (provider) => {
        try {
          const models = await unfilteredModels(provider.id)
          return { id: provider.id, name: provider.name, models: models.map(model => ({ id: model.id, name: model.name ?? model.id })) }
        } catch (error) {
          return { id: provider.id, name: provider.name, models: [], error: error instanceof Error ? error.message : String(error) }
        }
      }))
      return result.sort((a, b) => (fallbackOrder.get(a.id) ?? 0) - (fallbackOrder.get(b.id) ?? 0))
    },
    defaultModel,
    surface,
  }

  registerManagement(ctx, host, settingsNs)

  ctx.inject(['commands'], (child) => {
    child.effect(function* () {
      for (const command of createCommands(host)) {
        yield child.commands.register({
          name: command.name,
          description: command.description,
          ...command.hint === undefined ? {} : { input: { hint: command.hint } },
          handler: async ({ agent, rawInput, signal }) => {
            const context = agent.session.requestContext()
            return await command.run({
              args: rawInput,
              ...context ? { current: { provider: context.provider, model: context.model } } : {},
              ask: askVia(ctx.get('userQuestions'), agent, signal),
            })
          },
        })
      }
    })
  })
}
