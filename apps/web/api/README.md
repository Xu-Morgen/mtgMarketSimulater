# API 管理层（api）

本层集中管理浏览器到 Fastify API 的通信：基础请求客户端、认证与会话处理、领域 API 方法、TanStack Query 的 query/mutation 配置、查询键以及共享 `contracts` 包类型的引用。

所有写操作必须生成并发送 idempotency key；mutation 成功后必须以服务端响应更新缓存或失效相关查询。错误必须保留服务端可展示的错误信息和请求上下文，以便页面显示重试、会话过期或不可交易原因。

不得在本层手写可与后端漂移的 DTO，也不得让页面或组件自行拼接 API URL、重复实现请求重试或缓存失效策略。不得从客户端调用 Scryfall、MTGJSON 或 OpenAI。
