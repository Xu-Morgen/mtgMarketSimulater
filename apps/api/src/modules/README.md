# 业务模块

每个模块自主拥有 API、应用编排、领域模型和基础设施适配。除 `jobs` 外统一使用 `api`、`application`、`domain`、`infrastructure` 四层；不得跨模块直接查询或更新对方拥有的数据。
