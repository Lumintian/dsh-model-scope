/**
 * The scope engine: decide which models are visible and in what order.
 *
 * Patterns are matched against both `<provider>/<model>` and `<model>`: a glob
 * (`*` wildcard, case-insensitive, whole name) or `/pattern/flags`.
 *
 * - Visibility: `exclude` hides a model in either mode; in `include` mode a
 *   model must also match some `include` pattern. With `keepDefault`, the
 *   default model stays visible whatever the rules say.
 * - Model order inside a provider: by the index of the first `include`
 *   pattern the model matches; unmatched models follow; ties keep the
 *   provider's own order.
 * - Provider order: `providerOrder` first, in that order; then by the best
 *   `include` index among the provider's visible models; ties keep the
 *   original order.
 */

import { FAVORITE_MARK, type ScopeSettings } from './config.ts'

export interface ModelRef {
  provider: string
  model: string
}

export interface CompiledPattern {
  /** Position in its list. */
  index: number
  source: string
  regex: RegExp
}

/** Parse `/pattern/flags` as a regular expression, anything else as a case-insensitive glob. */
export function parseMatch(match: string): RegExp {
  const trimmed = match.trim()
  if (!trimmed) throw new Error('pattern is empty')
  const literal = /^\/(.+)\/([a-z]*)$/s.exec(trimmed)
  if (literal) {
    // Stateful flags would make repeated tests alternate between hits and misses.
    const flags = (literal[2] ?? '').replace(/[gy]/g, '')
    return new RegExp(literal[1] ?? '', flags)
  }
  const source = trimmed.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${source}$`, 'i')
}

/** `provider/model`, the exact pattern a command writes for one model. */
export function exactPattern(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`
}

/** Whether a pattern is literally this model's exact entry (no wildcard, no regex). */
export function isExactFor(pattern: string, ref: ModelRef): boolean {
  return pattern.trim().toLowerCase() === exactPattern(ref).toLowerCase()
}

/** Whether a pattern names one model exactly rather than a family. */
export function isExactPattern(pattern: string): boolean {
  const trimmed = pattern.trim()
  return !trimmed.includes('*') && !/^\/.+\/[a-z]*$/s.test(trimmed)
}

function compile(list: readonly string[], field: string, issues: string[]): CompiledPattern[] {
  const compiled: CompiledPattern[] = []
  list.forEach((source, index) => {
    try {
      compiled.push({ index, source, regex: parseMatch(source) })
    } catch (error) {
      issues.push(`${field}[${index}] (${JSON.stringify(source)}): ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  return compiled
}

function matches(pattern: CompiledPattern, ref: ModelRef): boolean {
  return pattern.regex.test(ref.model) || pattern.regex.test(exactPattern(ref))
}

export type Visibility =
  | { visible: true; reason: 'shown'; includeIndex?: number }
  | { visible: true; reason: 'kept-default'; hiddenBy?: string }
  | { visible: false; reason: 'excluded'; pattern: string }
  | { visible: false; reason: 'not-included' }

export class Scope {
  readonly settings: ScopeSettings
  /** Patterns that could not be compiled; each is ignored. */
  readonly issues: string[] = []
  private readonly include: CompiledPattern[]
  private readonly exclude: CompiledPattern[]
  private readonly favorites: CompiledPattern[]
  private readonly providerRank: Map<string, number>

  constructor(settings: ScopeSettings) {
    this.settings = settings
    this.include = compile(settings.include, 'include', this.issues)
    this.exclude = compile(settings.exclude, 'exclude', this.issues)
    this.favorites = compile(settings.favorites, 'favorites', this.issues)
    this.providerRank = new Map()
    settings.providerOrder.forEach((id, index) => {
      const key = id.trim().toLowerCase()
      if (key && !this.providerRank.has(key)) this.providerRank.set(key, index)
    })
  }

  /** Whether this scope changes nothing at all. */
  get isIdentity(): boolean {
    return this.include.length === 0 && this.exclude.length === 0 && this.providerRank.size === 0
      && this.settings.mode === 'all' && !this.marksFavorites
  }

  /** Whether favorite names get the ★ marker. */
  get marksFavorites(): boolean {
    return this.settings.markFavorites && this.favorites.length > 0
  }

  /** Index of the first `favorites` pattern the model matches. */
  favoriteIndex(ref: ModelRef): number | undefined {
    return this.favorites.find(pattern => matches(pattern, ref))?.index
  }

  /** Index of the first `include` pattern the model matches. */
  includeIndex(ref: ModelRef): number | undefined {
    return this.include.find(pattern => matches(pattern, ref))?.index
  }

  /** The first `exclude` pattern hiding the model. */
  excludedBy(ref: ModelRef): string | undefined {
    return this.exclude.find(pattern => matches(pattern, ref))?.source
  }

  explain(ref: ModelRef, isDefault = false): Visibility {
    const excluded = this.excludedBy(ref)
    const includeIndex = this.includeIndex(ref)
    const hidden = excluded !== undefined || (this.settings.mode === 'include' && includeIndex === undefined)
    if (!hidden) return { visible: true, reason: 'shown', ...includeIndex === undefined ? {} : { includeIndex } }
    if (isDefault && this.settings.keepDefault) {
      return { visible: true, reason: 'kept-default', ...excluded === undefined ? {} : { hiddenBy: excluded } }
    }
    return excluded !== undefined ? { visible: false, reason: 'excluded', pattern: excluded } : { visible: false, reason: 'not-included' }
  }

  isVisible(ref: ModelRef, isDefault = false): boolean {
    return this.explain(ref, isDefault).visible
  }

  /**
   * Filter and sort one provider's models.
   * @param provider - provider id.
   * @param models - the provider's models in its own order.
   * @param idOf - model id of an item.
   * @param defaultRef - the default selection, kept visible under `keepDefault`.
   */
  orderModels<T>(provider: string, models: readonly T[], idOf: (item: T) => string, defaultRef?: ModelRef): T[] {
    const ranked: Array<{ item: T; rank: number; position: number }> = []
    models.forEach((item, position) => {
      const ref = { provider, model: idOf(item) }
      const isDefault = defaultRef !== undefined && defaultRef.provider === provider && defaultRef.model === ref.model
      if (!this.isVisible(ref, isDefault)) return
      ranked.push({ item, rank: this.includeIndex(ref) ?? Number.POSITIVE_INFINITY, position })
    })
    ranked.sort((a, b) => a.rank - b.rank || a.position - b.position)
    return ranked.map(entry => entry.item)
  }

  /**
   * Sort providers.
   * @param providers - providers in their original order.
   * @param idOf - provider id of an item.
   * @param visibleModelsOf - the provider's visible model ids when known; unknown providers rank by `providerOrder` only.
   */
  orderProviders<T>(
    providers: readonly T[],
    idOf: (item: T) => string,
    visibleModelsOf: (provider: string) => readonly string[] | undefined,
  ): T[] {
    const ranked = providers.map((item, position) => {
      const id = idOf(item)
      const explicit = this.providerRank.get(id.toLowerCase()) ?? Number.POSITIVE_INFINITY
      let best = Number.POSITIVE_INFINITY
      for (const model of visibleModelsOf(id) ?? []) {
        const index = this.includeIndex({ provider: id, model })
        if (index !== undefined && index < best) best = index
      }
      return { item, explicit, best, position }
    })
    ranked.sort((a, b) => a.explicit - b.explicit || a.best - b.best || a.position - b.position)
    return ranked.map(entry => entry.item)
  }
}

interface CatalogModelLike {
  id: string
}

interface CatalogGroupLike {
  id: string
  models: readonly CatalogModelLike[]
}

interface CatalogLike {
  default?: unknown
  groups: readonly CatalogGroupLike[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Whether a value has the shape of dsh's `ModelCatalog` as far as this plugin relies on it. */
export function isCatalog(value: unknown): value is CatalogLike {
  if (!isRecord(value) || !Array.isArray(value['groups'])) return false
  return (value['groups'] as unknown[]).every(group => isRecord(group) && typeof group['id'] === 'string'
    && Array.isArray(group['models'])
    && (group['models'] as unknown[]).every(model => isRecord(model) && typeof model['id'] === 'string'))
}

export function defaultOf(catalog: { default?: unknown }): ModelRef | undefined {
  const value = catalog.default
  if (!isRecord(value) || typeof value['provider'] !== 'string' || typeof value['model'] !== 'string') return undefined
  return { provider: value['provider'], model: value['model'] }
}

/**
 * Apply a scope to a model catalog. Every field other than the groups and
 * their model lists is passed through untouched, so fields added by newer
 * dsh versions survive. Groups left empty are dropped, like dsh does itself.
 * A value without the expected shape is returned as is.
 */
export function scopeCatalog<T>(catalog: T, scope: Scope): T {
  if (scope.isIdentity || !isCatalog(catalog)) return catalog
  const defaultRef = defaultOf(catalog)
  const mark = (provider: string) => <M extends CatalogModelLike>(model: M): M => {
    if (!scope.marksFavorites || scope.favoriteIndex({ provider, model: model.id }) === undefined) return model
    const name = (model as { name?: unknown }).name
    if (typeof name !== 'string' || name.startsWith(FAVORITE_MARK)) return model
    return { ...model, name: `${FAVORITE_MARK} ${name}` }
  }
  const groups = catalog.groups
    .map(group => ({ ...group, models: scope.orderModels(group.id, group.models, model => model.id, defaultRef).map(mark(group.id)) }))
    .filter(group => group.models.length > 0)
  const visible = new Map(groups.map(group => [group.id, group.models.map(model => model.id)]))
  return { ...catalog, groups: scope.orderProviders(groups, group => group.id, id => visible.get(id)) }
}
