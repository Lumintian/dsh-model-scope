# 更新记录

## 0.1.0

首个版本：

- 用 `mode`、`include`、`exclude`、`providerOrder`、`keepDefault` 控制模型选择器显示哪些模型、按什么顺序显示，对所有 provider 生效。规则支持通配符和正则，同时匹配 `provider/模型` 和 `模型`。
- web 和桌面端 profile 只过滤给浏览器的模型目录：被隐藏的模型仍然可以用，发消息、子智能体和服务端校验不受影响。
- 其他 profile（例如 `acp`）过滤 `llm.listModels` / `llm.listProviders`，ACP 客户端的模型下拉框跟着变。
- 配置变了立即生效，打开着的选择器也会刷新；停用或卸载时还原。
- `/model-scope` 命令：用卡片显示/隐藏模型、调整优先级列表和 provider 顺序、切换模式、查看状态、恢复默认；也支持 `status`、`hide`、`show`、`top`、`mode`、`reset` 参数。
