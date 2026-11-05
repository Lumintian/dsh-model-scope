# dsh-model-scope

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh，0.2.1-rc.5+）的模型选择器定一个「范围」：**哪些模型显示、按什么顺序显示**。对所有 provider 的所有模型都有效，不只是某一个插件注册的模型。

- **显示/隐藏**：用通配符或正则批量隐藏（例如所有图片模型），也可以在卡片里逐个勾选。
- **优先级**：一个有序列表，越靠前越优先。同一个 provider 分组里按它排序；分组之间，含有更靠前模型的分组排在前面。
- **白名单模式**：只显示优先级列表里的模型，其余全部隐藏。
- **provider 顺序**：直接指定分组的先后。
- **收藏与轮切**：收藏常用的几个模型，用快捷键（默认 Ctrl+Alt+M）在它们之间轮流切换，或者用 `/fav` 直接挑一个。收藏的模型在选择器里带 ★。
- **只改显示，不影响使用**：被隐藏的模型仍然可以用。正在用它的会话照常发消息，子智能体、服务端校验看到的仍是完整列表。
- 改配置后立即生效，不用重启，打开着的模型选择器也会跟着刷新。

## 安装

需要 dsh 0.2.1-rc.5+（Node 24.9+）。

```bash
dsh plugin --profile web add @lumintian/dsh-model-scope
```

升级到最新版用同一条命令，加上 `@latest`：

```bash
dsh plugin --profile web add @lumintian/dsh-model-scope@latest
```

`--profile` 写你启动 dsh 时用的 profile：`dsh web` 用 `web`，`dsh acp` 用 `acp`，桌面端用它自己的 profile。**插件装在哪个 profile，就只在哪个 profile 生效**，每个 profile 的配置也各自独立。只装在 `web` 里，ACP 客户端里的模型列表不会变。

## 在哪里生效

| profile | 过滤的是 | 不受影响的 |
|---|---|---|
| `web`、桌面端 | Web 模型选择器、「设置 → 模型」页、子智能体模型卡片用的模型目录 | 发消息、子智能体调用、子智能体的 `list_models` 工具、服务端对模型的校验 |
| `acp` 等其他 profile | 这个 profile 里 `llm.listModels` / `llm.listProviders` 返回的列表，也就是 ACP 客户端（例如 Zed）的模型下拉框 | 发消息和模型校验（ACP 用别的接口校验，并且会自己把当前模型补回列表） |

在 `acp` 这类 profile 里有一个副作用：同一个进程里，子智能体的 `list_models` 工具看到的也是过滤后的列表。

## 快速开始（Web）

在输入框里输入 `/model-scope` 回车，会弹出操作菜单：

- **显示/隐藏模型**：先选 provider，再在卡片里勾选要隐藏的模型；翻到下一页可以勾选要重新显示的模型。
- **调整模型优先级**：添加模型到优先级列表（放最前或最后）、调整某一条的位置、移除条目。
- **收藏与轮切**：添加收藏、调整收藏顺序（也就是轮切顺序）、取消收藏。
- **调整 provider 顺序**：选一个 provider，移到最前、上移、下移、移到最后，或恢复默认顺序。
- **切换模式**：`all`（默认全部显示）或 `include`（白名单）。
- **查看状态**：每个 provider 显示了几个模型、按什么顺序、隐藏了哪些。
- **恢复默认**：清空所有设置。

卡片里的每个模型都带说明：当前会话在用、默认模型、★ 收藏、优先级第几、被哪条规则隐藏。模型很多时，卡片会按 30 个一页分页。

## 收藏与轮切（Web、桌面端）

先用 `/model-scope` → 收藏与轮切 → 添加模型（或 `/model-scope fav cpa-home/gpt-5.5`）收藏几个常用模型，然后：

| 操作 | 作用 |
|---|---|
| **Ctrl+Alt+M**（macOS：⌘⌥M） | 当前会话切到下一个收藏模型 |
| **Ctrl+Alt+Shift+M**（macOS：⌘⌥⇧M） | 切到上一个收藏模型 |
| `/fav` | 弹出收藏列表（可搜索），选一个直接切换；当前模型打勾，角标是轮切顺序 |
| `/fav-next`、`/fav-prev` | 和快捷键一样，适合没法用快捷键的时候 |

- 轮切顺序就是 `favorites` 列表的顺序。当前模型不是收藏时，「下一个」从第一个开始，「上一个」从最后一个开始；到头后绕回。
- 切换后输入框上方会提示「已切换到 GLM-5（收藏 2/3）」，选择器按钮也会跟着变。切换和在选择器里手动选是一样的：推理档位用新模型的默认值，dsh 也会把它记成默认模型。
- 只在选择器里**看得到**的收藏之间轮切：被隐藏的收藏、暂时没有注册的 provider 会被跳过。
- 快捷键可以改：按 Ctrl+/ 打开 dsh 的快捷键面板，找「切换到下一个收藏模型」「切换到上一个收藏模型」。
- **Linux 上的 Web 版没有默认快捷键**：dsh 在 Linux 浏览器里只允许三个固定的组合键，而且都已被占用，所以只能用 `/fav-next`、`/fav-prev` 和 `/fav`。Linux 桌面端不受影响。
- 收藏的模型在选择器里带 ★（选择器按钮上也会显示）。不想要可以设 `markFavorites: false`。

## 配置

命令写入的就是 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）里 id 为 `model-scope` 的条目，也可以直接手动编辑。所有字段改了立即生效。

```yaml
- id: model-scope
  config:
    mode: all                  # all：默认全部显示；include：只显示 include 命中的
    include:                   # 优先级列表，越靠前越优先
      - 'cpa-home/gpt-5.5'
      - 'cpa-home/gpt-6-*'
      - 'deepseek-official/*'
    exclude:                   # 隐藏的模型，两种模式都生效，优先于 include
      - '*/gpt-image-*'
    providerOrder: [cpa-home, openrouter]   # 可选：分组顺序
    keepDefault: true          # 默认模型即使被隐藏也保留在列表里
    favorites:                 # 收藏，按这个顺序轮切
      - 'cpa-home/gpt-5.5'
      - 'deepseek-official/deepseek-chat'
    markFavorites: true        # 收藏的模型名前加 ★
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `mode` | `all` | `all`：没被 `exclude` 命中的都显示。`include`：只显示被 `include` 命中、且没被 `exclude` 命中的。 |
| `include` | `[]` | 有序的规则列表。决定排序；`include` 模式下也是白名单。 |
| `exclude` | `[]` | 隐藏规则，两种模式都生效，优先级高于 `include`。 |
| `providerOrder` | `[]` | provider ID 列表，列出的分组按这个顺序排在最前，没列出的排在后面。 |
| `keepDefault` | `true` | dsh 的默认模型（新会话默认选中的那个）总是显示，避免新会话的模型按钮变成「请选择模型」。 |
| `favorites` | `[]` | 收藏，有序。快捷键、`/fav`、`/fav-next`、`/fav-prev` 按这个顺序在收藏之间切换。规则写法和 `include` 一样。 |
| `markFavorites` | `true` | 在 Web 模型选择器里给收藏的模型名前加 ★。 |

更多写法见 [`examples/`](examples/)。

### 规则写法

- 每条规则同时和 `provider/模型` 和 `模型` 比较，命中任意一个就算命中。provider 就是模型选择器分组对应的 ID，例如 `cpa-home`、`deepseek-official`、`openrouter`；可以用 `/model-scope status` 查看。
- `*` 是通配符，不区分大小写，要整串匹配：`gpt-5*` 命中 `gpt-5.5`，`gpt-5` 不命中 `gpt-5.5`。
- `/正则/flags` 写正则，例如 `'/^gpt-(5|6)/i'`。
- 写错的规则会被忽略，并在 dsh 日志和 `/model-scope status` 里提示。

### 排序规则

1. **分组之间**：先按 `providerOrder`；没列出的分组，按组里排得最靠前的模型在 `include` 里的位置排；再没有的保持 dsh 原来的顺序（也就是 provider 注册的顺序）。
2. **分组之内**：按每个模型命中的第一条 `include` 规则的位置排；没命中的排在后面，保持原来的顺序。
3. 例：`include` 是 `[openrouter/claude-x, cpa-home/gpt-5.5]`，那 openrouter 分组会排在 cpa-home 前面，因为它含有优先级第 1 的模型。

做不到的：

- **DeepSeek 两个分组总在最前。** dsh Web 选择器把「DeepSeek 账号」和「DeepSeek 官方」固定排在最前，这是客户端写死的，插件改不了。
- **不能跨分组混排。** 选择器按 provider 分组显示，所以「A 家的模型 1、B 家的模型 2、A 家的模型 3」这种顺序做不到。

## 命令

只有交互界面（Web、桌面端）能弹出卡片。在不能弹卡片的界面里，`/model-scope` 会显示状态和下面的参数写法。

| 写法 | 作用 |
|---|---|
| `/model-scope` | 打开菜单 |
| `/model-scope status` | 查看当前设置，以及每个 provider 显示了哪些模型 |
| `/model-scope hide <规则…>` | 把规则加入 `exclude`，例如 `/model-scope hide */gpt-image-* o4-mini` |
| `/model-scope show <规则…>` | 从 `exclude` 删掉同样写法的规则；`include` 模式下同时加入优先级列表 |
| `/model-scope top <规则…>` | 放到优先级列表最前 |
| `/model-scope fav [规则…]` | 加入收藏（加在末尾）；不写规则时打开收藏菜单 |
| `/model-scope unfav <规则…>` | 取消收藏（删掉同样写法的规则） |
| `/model-scope mode all\|include` | 切换模式；优先级列表为空时不允许切到 `include`（会隐藏所有模型） |
| `/model-scope reset` | 恢复默认 |

卡片勾选写入的都是精确规则（`provider/模型`）。如果一个模型是被通配符或正则规则隐藏的，在卡片里勾「重新显示」不会生效，结果里会说明是哪条规则挡住了它，需要手动改 `exclude`。

## Web 使用须知

这几条是 dsh Web 界面本身的行为，插件这边改变不了：

- **还没聊过天的新会话里，命令结果不显示。** 命令其实已经执行了，弹出的卡片也照常显示，只是结果文字要等会话里有了第一条消息才会出现。可以直接打开模型选择器看效果。
- **输入命令后直接回车，会选中命令菜单里高亮的那一项。** 例如输入 `/fav` 时菜单里还有 `/fav-next`、`/fav-prev`，高亮的是 `/fav`。想执行别的，用方向键在菜单里选。
- 带参数的命令（例如 `/model-scope status`）照常输入、回车即可；只输入 `/model-scope` 回车会直接打开菜单。
- **命令结果默认只显示第一行**，点一下这一行可以展开。本插件所有结果的第一行都是一句话总结。
- **只有一道题的卡片，选完要点「提交」**；多道题的卡片点「下一题」翻页，单选题选完会自动跳到下一题。
- 卡片等待回答时如果关掉或刷新页面，这次命令会被取消（显示 `This operation was aborted`），不会做任何修改。

## 隐藏了正在用的模型会怎样

- **当前会话**：照常可以发消息，用的还是原来的模型；只是输入框右下角的模型按钮会显示「请选择模型」，因为选择器里找不到它了。换一个模型，或者重新显示它，按钮就恢复正常。
- **默认模型**：开着 `keepDefault`（默认开）时，默认模型总会显示。关掉后，如果它被隐藏，新会话的模型按钮会显示「请选择模型」，需要先选一个模型。
- **「设置 → 模型」页**：这个页面根据目录里有没有「DeepSeek 账号」的模型，来决定显不显示账号那一行。如果把 `deepseek-account` 的模型全部隐藏，那一行也会消失；恢复显示后就回来了。

## 和 dsh-cpa-provider 一起用

[dsh-cpa-provider](https://github.com/Lumintian/dsh-cpa-provider) 的 `models` 规则里的 `hidden` 先生效：被它隐藏的模型根本不会注册进 dsh，本插件也就看不到。建议分工：

- 思考档位、默认强度、Fast 继续用 CPA 插件的规则管；
- 显示哪些模型、按什么顺序，交给本插件，这样所有 provider 用同一套规则。

## 兼容性与原理

插件分两半：服务端（宿主）一半负责过滤、排序和 `/model-scope` 命令；浏览器端一半（`client/client.js`，只在 Web 和桌面端加载）负责收藏的快捷键、`/fav`、`/fav-next`、`/fav-prev`，以及让 `/model-scope` 回车一次就打开菜单。浏览器端通过插件自己的设置条目读收藏，所以 profile 里本插件条目的 id 要保持为 `model-scope`（安装时默认就是）。

dsh 没有给模型列表留扩展点。本插件在 dsh 的服务实例上包装了几个方法：web 和桌面端的 profile 里包装模型目录接口（`sessionController.modelCatalog`），其他 profile 里包装 `llm.listModels` 和 `llm.listProviders`。配置变了，插件会发出 `llm/adapters-updated` 事件，让选择器重新拉取目录。

- 启动时会先检查这些方法在不在；结构不对就放弃过滤，并在 dsh 日志里留一条 `dsh-model-scope` 警告，不会影响 dsh 启动。`/model-scope status` 也会提示插件没有生效。
- 停用或卸载插件时，被包装的方法会还原，选择器也会刷新回完整列表。
- `engines.dsh` 声明的范围是 `>=0.2.1-rc.5 <0.3.0`。已在 dsh 0.2.1-rc.5 上验证过 web 和 acp 两个 profile。

## 开发

```bash
pnpm install
pnpm check   # 类型检查 + 测试，需要 Node 24
pnpm build   # 编译到 lib/
```

测试用 Node 的 `node --test` 直接跑 TypeScript。`tests/plugin.e2e.test.ts` 用真实的 Cordis、dsh LLM 运行时和 Loader 挂载插件，分别模拟 web profile 和 ACP profile。`tests/client.test.ts` 按 dsh 客户端模块系统的方式加载 `client/client.js`，用模拟的快捷键、模型目录、命令服务驱动它。

浏览器端是手写的 dsh lazy-CJS factory 格式（`window.__ModuleLoader__.load({ id, factory })`），不需要构建，也不 `require` 任何模块，只用 Context 上的服务。

## 许可

MIT
