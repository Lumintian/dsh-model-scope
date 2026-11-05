# AGENTS.md

本文件适用于 `dsh-model-scope` 整个项目。

## 项目定位

DeepSeek Harness（dsh）的 Cordis 插件：按 `mode` / `include` / `exclude` / `providerOrder` / `keepDefault` 决定模型列表显示哪些模型、按什么顺序显示，对所有 provider 生效；`favorites` 是有序收藏，浏览器端用快捷键和 `/fav*` 命令在收藏之间轮切。dsh 没有模型列表的扩展点，插件通过包装 dsh 服务实例上的方法实现。

开始修改前阅读 `README.md`。涉及 dsh 接口时，核对 `devDependencies` 里固定的 dsh 版本的类型声明和官方源码（`github.com/deepseek-ai/deepseek-harness`，对应 `dsh-vX.Y.Z` tag），不凭记忆猜接口。关键位置：`packages/api/session-controller/src/catalog.ts`（`buildModelCatalog`、`modelAvailable`）、`packages/api/gateway/src/index.ts`（RPC 每次调用时按名字取方法）、`packages/acp/acp/src/model-control.ts`、`packages/client/ui-model-selection/src/client/provider-order.ts`。

## 目录与职责

- `src/index.ts`：插件入口。读取 volatile 配置；web/桌面 profile 包装 `sessionController.modelCatalog`，其他 profile 包装 `llm.listModels` / `llm.listProviders`；配置变化时发 `llm/adapters-updated`；注册 `/model-scope`。
- `src/config.ts`：Schemastery 配置 schema 和默认值。
- `src/scope.ts`：规则解析、可见性、组内与分组排序、`scopeCatalog`。纯函数，不依赖 dsh。
- `src/patch.ts`：可还原的方法包装（特性检测、包装 Cordis 代理背后的原始实例、只在自己仍是最外层时删除）。
- `src/ask.ts`：提问卡片（`ctx.userQuestions`）的封装。
- `src/commands.ts`：`/model-scope` 菜单和参数，通过 `CommandHost` 访问配置和目录，便于测试。
- `client/client.js`：浏览器端，手写的 dsh lazy-CJS factory（`window.__ModuleLoader__.load`），不构建、不 `require` 任何模块。注册收藏轮切快捷键、`/fav`、`/fav-next`、`/fav-prev`，并给宿主的 `/model-scope` 挂裸调用装饰。收藏从 `configForms.get('model-scope')` 读，模型从 `modelDirectories.directoryFor(sessionId)` 读、用它的 `select()` 切换。
- `tests/`：`scope.test.ts` 单元测试；`commands.test.ts` 用脚本化的卡片回答驱动命令；`plugin.e2e.test.ts` 在真实 Cordis + dsh-llm 运行时里分别模拟 web 和 ACP profile；`client.test.ts` 按客户端模块系统的方式加载 `client/client.js` 并用模拟服务驱动。

## 必须保持的行为

1. **只改显示，不影响使用**：web/桌面 profile 里绝不能过滤 `llm.listModels`——发消息前的 `modelAvailable` 校验用的就是它，过滤了会让隐藏模型的会话发不出消息。`listModels` 包装在存在 `sessionController` 服务时必须直接透传。
2. **失败隔离**：方法不存在、实例不可写、返回结构不认识时放弃过滤并记一条警告，绝不能影响 dsh 启动或让目录接口报错；过滤出错时返回原始结果。
3. **透传未知字段**：目录里分组和模型的其他字段（新版 dsh 可能新增）原样保留；空分组要去掉（和 dsh 自己一致）。
4. **可还原**：卸载或停用时还原被包装的方法并再发一次 `llm/adapters-updated`。
5. **热更新**：配置字段都是 volatile；配置真正变化时才发 `llm/adapters-updated`。
6. **浏览器端只用公开的 Context 服务**：访问 `remote.<命名空间>` 这类关联属性前必须在 `ctx.inject` 里声明（否则 dsh 抛 `cannot get property ... without inject`）；任何一个服务缺失时只放弃对应功能。快捷键默认值不能和 dsh 已有默认值冲突，冲突时退回无默认键注册。Linux Web 不给默认键（dsh 只允许三个固定组合）。
7. **命令交互**：不带参数也能用，缺的信息用卡片问；不能弹卡片时回退到状态加用法说明。结果第一行必须是一句话总结（dsh Web 只显示第一行）。卡片写入精确规则，不改用户手写的通配/正则规则，挡住时如实说明。

## 修改与交付

- 代码风格：单引号、无分号、两空格缩进；保持 `erasableSyntaxOnly`（测试直接用 Node 24 的类型剥离运行），相对导入写 `.ts` 后缀。
- 修缺陷要加回归测试；改规则语义要覆盖 `scope.test.ts`；改包装方式要在 e2e 测试里覆盖 web 和 ACP 两种 profile。
- 用户可见行为变化时同步更新 `README.md`、`CHANGELOG.md` 和 `examples/`，发布前改 `package.json` 版本号。用户文档用中文。
- 交付前运行 `pnpm check`（需要 Node 24），涉及打包时再跑 `pnpm build`；改动包装逻辑时在真实 dsh 里验证。不提交 `lib/`、`node_modules/`、凭据或本机路径。
