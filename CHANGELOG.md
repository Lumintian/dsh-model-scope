# 更新记录

## 0.2.0

收藏与轮切，以及几处交互改进：

- 新增 `favorites`（有序的收藏列表，也是轮切顺序）和 `markFavorites`（在 Web 选择器里给收藏的模型名加 ★，默认开）。
- 新增浏览器端：快捷键 Ctrl+Alt+M / Ctrl+Alt+Shift+M（macOS ⌘⌥M / ⌘⌥⇧M）切到下一个 / 上一个收藏模型，可在 dsh 快捷键面板（Ctrl+/）里改绑；`/fav` 弹出可搜索的收藏列表；`/fav-next`、`/fav-prev` 用于没有快捷键的环境（Linux 上的 Web 版）。切换后输入框上方会提示切到了哪个。
- `/model-scope` 菜单新增「收藏与轮切」；参数新增 `fav`、`unfav`；状态里列出收藏，卡片里标出 ★ 收藏。
- 只输入 `/model-scope` 回车会直接打开菜单（之前要按两次回车，或先按 Esc）；带参数的写法不变。

## 0.1.0

首个版本：

- 用 `mode`、`include`、`exclude`、`providerOrder`、`keepDefault` 控制模型选择器显示哪些模型、按什么顺序显示，对所有 provider 生效。规则支持通配符和正则，同时匹配 `provider/模型` 和 `模型`。
- web 和桌面端 profile 只过滤给浏览器的模型目录：被隐藏的模型仍然可以用，发消息、子智能体和服务端校验不受影响。
- 其他 profile（例如 `acp`）过滤 `llm.listModels` / `llm.listProviders`，ACP 客户端的模型下拉框跟着变。
- 配置变了立即生效，打开着的选择器也会刷新；停用或卸载时还原。
- `/model-scope` 命令：用卡片显示/隐藏模型、调整优先级列表和 provider 顺序、切换模式、查看状态、恢复默认；也支持 `status`、`hide`、`show`、`top`、`mode`、`reset` 参数。
