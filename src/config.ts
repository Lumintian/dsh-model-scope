/**
 * Plugin configuration: which models the model lists show and in what order.
 *
 * Every field is volatile, so editing the profile's `cordis.patch.yml` (or the
 * `/model-scope` command writing it) takes effect without remounting.
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const MODES = ['all', 'include'] as const
export type Mode = typeof MODES[number]

export interface Config {
  /** `all`: every model shows unless `exclude` hides it. `include`: only models matched by `include` show. */
  mode: Volatile<Mode>
  /** Ordered patterns: the order is the priority. In `include` mode it is also the allow list. */
  include: Volatile<string[]>
  /** Patterns hidden in either mode; `exclude` wins over `include`. */
  exclude: Volatile<string[]>
  /** Provider ids shown first, in this order; unlisted providers follow. */
  providerOrder: Volatile<string[]>
  /** Keep the default model listed even when a rule would hide it. */
  keepDefault: Volatile<boolean>
  /** Ordered favorite patterns: the models the cycle shortcut and `/fav` go through, in this order. */
  favorites: Volatile<string[]>
  /** Prefix favorite model names with ★ in the browser model catalog. */
  markFavorites: Volatile<boolean>
}

/** Raw section as written in `cordis.patch.yml`, before defaults. */
export interface ConfigInput {
  mode?: Mode | null
  include?: string[] | null
  exclude?: string[] | null
  providerOrder?: string[] | null
  keepDefault?: boolean | null
  favorites?: string[] | null
  markFavorites?: boolean | null
}

const PATTERN_HELP = '写法：provider/模型 或 模型；* 是通配符，不区分大小写；/正则/flags 写正则'

export const Config: z<ConfigInput, Config> = z.object({
  mode: z.union(MODES).default('all').volatile()
    .description('all：默认全部显示，只隐藏 exclude 命中的；include：只显示 include 命中的'),
  include: z.array(z.string()).default([]).volatile()
    .description(`优先级列表，越靠前越优先；include 模式下也是白名单。${PATTERN_HELP}`),
  exclude: z.array(z.string()).default([]).volatile()
    .description(`隐藏的模型，两种模式都生效，优先于 include。${PATTERN_HELP}`),
  providerOrder: z.array(z.string()).default([]).volatile()
    .description('provider 分组顺序（provider ID）；没列出的排在后面'),
  keepDefault: z.boolean().default(true).volatile()
    .description('默认模型即使被规则隐藏也保留在列表里'),
  favorites: z.array(z.string()).default([]).volatile()
    .description(`收藏的模型，按这个顺序轮切（快捷键、/fav）。${PATTERN_HELP}`),
  markFavorites: z.boolean().default(true).volatile()
    .description('在模型选择器里给收藏的模型名前加 ★'),
})

/** Plain settings the scope engine works from. */
export interface ScopeSettings {
  mode: Mode
  include: string[]
  exclude: string[]
  providerOrder: string[]
  keepDefault: boolean
  favorites: string[]
  markFavorites: boolean
}

export const DEFAULT_SETTINGS: ScopeSettings = {
  mode: 'all',
  include: [],
  exclude: [],
  providerOrder: [],
  keepDefault: true,
  favorites: [],
  markFavorites: true,
}

/** The marker prefixed to favorite model names in the browser catalog. */
export const FAVORITE_MARK = '★'

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}
