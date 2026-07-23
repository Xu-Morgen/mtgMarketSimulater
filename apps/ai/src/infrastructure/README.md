# 基础设施层

本层实现应用端口，与 OpenAI Responses API、SQLite 仓储、日志、指标和运行环境交互。所有外部输入输出都在进入应用层前后完成序列化、脱敏、超时与错误映射。

适配器可以依赖具体 SDK，但不得把 SDK 类型扩散到 `domain` 或 `application`。

