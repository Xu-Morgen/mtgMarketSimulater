# 页面层（pages）

本层以用户可感知的业务场景组织页面模块：认证、仪表盘、补充包、库存、市场、挂售确认、卡组、比赛和管理后台。每个模块负责页面布局、加载/空/错误状态编排、权限入口判断和将查询数据传给组件。

页面可以调用 `api/` 提供的查询和 mutation，并组合 `components/`、读取 `stores/` 中的临时 UI 状态。页面不得实现 HTTP 细节、重复定义 DTO、计算余额/报价/费用/奖励/赛果，或直接修改服务器真相。

Next.js 的 `app/` 路由文件只负责路由协议和框架边界，应从本层引入对应的页面模块。建议的后续目录为 `auth/`、`dashboard/`、`packs/`、`inventory/`、`market/`、`listing/`、`decks/`、`tournaments/`、`admin/`。
