/** Shared model-management rules. The browser submits intents, never a second scope implementation. */
import type { ProviderModels } from './commands.ts'
import type { ScopeSettings } from './config.ts'
import { exactPattern, isExactFor, type ModelRef, Scope } from './scope.ts'

export type ManageAction = 'favorite' | 'unfavorite' | 'hide' | 'show' | 'top' | 'up' | 'down'
export const MANAGE_ACTIONS: readonly string[] = ['favorite', 'unfavorite', 'hide', 'show', 'top', 'up', 'down']

export interface ManagedModel {
  id: string
  name: string
  visible: boolean
  ruleHidden: boolean
  favorite: boolean
  favoriteRule?: string
  default: boolean
  reason: string
  up: boolean
  down: boolean
}

export interface ManagedProvider {
  id: string
  name: string
  models: ManagedModel[]
  error?: string
}

export function cloneSettings(settings: ScopeSettings): ScopeSettings {
  return { ...settings, include: [...settings.include], exclude: [...settings.exclude],
    providerOrder: [...settings.providerOrder], favorites: [...settings.favorites] }
}

export function changedFields(before: ScopeSettings, after: ScopeSettings): Partial<ScopeSettings> {
  const patch: Partial<ScopeSettings> = {}
  for (const key of Object.keys(after) as Array<keyof ScopeSettings>) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) (patch as Record<string, unknown>)[key] = after[key]
  }
  return patch
}

/** Hide one exact model without changing hand-written wildcard/regex rules. */
export function hideIn(draft: ScopeSettings, ref: ModelRef): void {
  if (draft.mode === 'include') draft.include = draft.include.filter(pattern => !isExactFor(pattern, ref))
  if (new Scope(draft).isVisible(ref) && !draft.exclude.some(pattern => isExactFor(pattern, ref))) {
    draft.exclude = [...draft.exclude, exactPattern(ref)]
  }
}

/** Restore an exact model; a broad exclude is deliberately not removed. */
export function showIn(draft: ScopeSettings, ref: ModelRef): string | undefined {
  draft.exclude = draft.exclude.filter(pattern => !isExactFor(pattern, ref))
  if (draft.mode === 'include' && new Scope(draft).includeIndex(ref) === undefined) {
    draft.include = [...draft.include, exactPattern(ref)]
  }
  return new Scope(draft).excludedBy(ref)
}

function isDefault(ref: ModelRef, fallback?: ModelRef): boolean {
  return fallback?.provider === ref.provider && fallback.model === ref.model
}

/** Full registry, including hidden models; shown models follow the existing priority rules. */
export function managedProviders(providers: ProviderModels[], settings: ScopeSettings, fallback?: ModelRef): ManagedProvider[] {
  const scope = new Scope(settings)
  return scope.orderProviders(providers, provider => provider.id, id => {
    const provider = providers.find(provider => provider.id === id)
    return provider ? scope.orderModels(id, provider.models, model => model.id, fallback).map(model => model.id) : []
  }).map((provider) => {
    const visible = scope.orderModels(provider.id, provider.models, model => model.id, fallback)
    const reorderable = visible.filter(model => scope.isVisible({ provider: provider.id, model: model.id }))
    const shown = new Set(visible.map(model => model.id))
    const models = [...visible, ...provider.models.filter(model => !shown.has(model.id))]
    return { ...provider, models: models.map((model): ManagedModel => {
      const ref = { provider: provider.id, model: model.id }
      const defaultModel = isDefault(ref, fallback)
      const visibility = scope.explain(ref, defaultModel)
      const favoriteIndex = scope.favoriteIndex(ref)
      const favoriteRule = favoriteIndex === undefined ? undefined : settings.favorites[favoriteIndex]
      const index = reorderable.findIndex(item => item.id === model.id)
      return {
        id: model.id, name: model.name, visible: visibility.visible, ruleHidden: visibility.reason !== 'shown',
        favorite: favoriteIndex !== undefined, ...favoriteRule === undefined ? {} : { favoriteRule }, default: defaultModel,
        reason: visibility.reason === 'excluded' ? `隐藏规则：${visibility.pattern}`
          : visibility.reason === 'not-included' ? '不在白名单中'
            : visibility.reason === 'kept-default' ? `默认模型受保护${visibility.hiddenBy ? `；隐藏规则：${visibility.hiddenBy}` : '；不在白名单中'}` : '',
        up: index > 0, down: index >= 0 && index < reorderable.length - 1,
      }
    }) }
  })
}

/** Plan an exact model operation. No caller can mutate unrelated hand-written rules. */
export function manageModel(settings: ScopeSettings, providers: ProviderModels[], ref: ModelRef, action: ManageAction, fallback?: ModelRef): Partial<ScopeSettings> {
  const provider = providers.find(provider => provider.id === ref.provider)
  if (!provider?.models.some(model => model.id === ref.model)) throw new Error('模型已不在注册目录中，请刷新后重试')
  const draft = cloneSettings(settings)
  const scope = new Scope(settings)
  if (action === 'favorite') {
    if (scope.favoriteIndex(ref) === undefined) draft.favorites.push(exactPattern(ref))
  } else if (action === 'unfavorite') {
    draft.favorites = draft.favorites.filter(pattern => !isExactFor(pattern, ref))
    const remaining = new Scope(draft).favoriteIndex(ref)
    if (remaining !== undefined) throw new Error(`收藏仍由规则「${draft.favorites[remaining]}」控制，请在插件配置中调整这条规则`)
  } else if (action === 'hide') {
    hideIn(draft, ref)
  } else if (action === 'show') {
    const blocked = showIn(draft, ref)
    if (blocked !== undefined) throw new Error(`仍被规则「${blocked}」隐藏，请在插件配置中调整这条规则`)
  } else {
    const ordered = scope.orderModels(provider.id, provider.models, model => model.id, fallback)
      .filter(model => scope.isVisible({ provider: provider.id, model: model.id }))
    const index = ordered.findIndex(model => model.id === ref.model)
    if (index < 0) throw new Error('请先恢复显示，再调整模型顺序')
    if (action === 'top') {
      draft.include = [exactPattern(ref), ...draft.include.filter(pattern => !isExactFor(pattern, ref))]
    } else {
      const target = action === 'up' ? index - 1 : index + 1
      if (target < 0 || target >= ordered.length) return {}
      const moved = ordered.splice(index, 1)[0]!
      ordered.splice(target, 0, moved)
      // Materialize only the currently visible group before the first rule that ranks it.
      // Keep wildcard/regex rules and hidden entries, including their whitelist meaning.
      const refs = ordered.map(model => ({ provider: provider.id, model: model.id }))
      const rank = Math.min(...refs.map(item => scope.includeIndex(item) ?? draft.include.length))
      const before = draft.include.slice(0, rank).filter(pattern => !refs.some(item => isExactFor(pattern, item)))
      const after = draft.include.slice(rank).filter(pattern => !refs.some(item => isExactFor(pattern, item)))
      draft.include = [...before, ...refs.map(exactPattern), ...after]
    }
  }
  return changedFields(settings, draft)
}
