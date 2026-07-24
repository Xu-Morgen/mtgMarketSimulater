# 前端项目架构

`apps/web` 使用 Next.js App Router。`app/` 仅定义路由段、布局、加载/错误边界与页面入口；它不承载业务数据请求、界面状态或复杂展示逻辑。路由入口应组合 `pages/` 中的页面模块。

## 分层目录

| 目录 | 职责 | 依赖方向 |
| --- | --- | --- |
| `pages/` | 面向业务场景的页面编排与路由入口可复用的页面模块。 | 可依赖 `components`、`stores`、`api`、`constants`、`utils`。 |
| `components/` | 可复用的展示组件、React Hook Form + Zod 表单组件、业务组件与图表/动画封装。 | 可依赖 `stores`、`constants`、`utils`；服务端数据由页面注入，或由明确的查询组件读取。 |
| `stores/` | Zustand 的瞬时 UI 状态，例如筛选、界面偏好、开包动画和未提交的卡组草稿。 | 只依赖 `constants`、`utils`；不得存放服务器真相。 |
| `api/` | API 客户端、请求封装、TanStack Query 的 query/mutation 配置及共享 contracts 类型的适配。 | 可依赖 `constants`、`utils` 与共享 `contracts` 包。 |
| `providers/` | React 全局 Provider 的集中装配，例如 TanStack Query、会话恢复与全局通知。 | 只依赖框架、`api`、`stores`、`constants`、`utils`；由 `app/` 根布局接入。 |
| `utils/` | 无业务副作用的通用工具、格式化、解析、校验与 idempotency key 生成。 | 可依赖 `constants`；不得请求 API 或读写 Zustand。 |
| `constants/` | 不会变化的前端常量、路由名、展示文案键、查询键及配置映射。 | 不依赖其他业务层。 |
| `tests/` | 前端单元、组件/集成与端到端测试，以及必要的测试夹具。 | 仅依赖被测层和测试工具；生产代码不得依赖本层。 |

## 数据与写操作规则

- 余额、库存、价格、订单、比赛、成就和后台配置均是服务器真相，只能由 TanStack Query 缓存和刷新；不得复制到 Zustand 或在浏览器计算结算结果。
- 所有 DTO 从共享 `contracts` 包导入；前端不得重定义与后端可能漂移的请求或响应类型。
- 所有变更操作由 `api/` 中的 mutation 发起，携带 idempotency key；成功后以服务端响应更新或失效相关查询缓存。
- 页面与组件只展示服务端返回的费用、保证金、奖励、赛果、开包结果和价格来源/更新时间，不推导或改写这些值。
- React Hook Form + Zod 仅提供字段级即时反馈；表单提交必须展示服务端返回的权限、版本冲突、参数上限和业务错误，不能把客户端校验当成安全边界。

## 计划中的页面模块

`pages/` 将按业务域建立 `auth`、`dashboard`、`catalog`、`packs`、`inventory`、`market`、`orders`、`decks`、`tournaments` 与 `admin`。其中买单/卖单确认是独立页面流程，必须读取服务端预览并二次确认。

`app/` 使用公开、玩家和管理员路由组组合这些页面模块。`admin` 至少拆分为首页、活动、玩家、内容/参数、任务/Agent 和日志页面；管理员布局负责导航与无权限/会话过期体验，但所有 `/v1/admin/*` 请求仍由 API 复核 `admin` 角色。

管理活动采用“草稿 → 服务端预览 → 二次确认 → 发布/定时发布 → 暂停/结束”的显式流程；玩家管理只提交冻结、解冻、会话撤销和补偿修正命令，不提供余额/库存最终值的自由编辑。审计与运行日志只读、服务端分页和脱敏，筛选条件保存在 URL 而不是 Zustand。

## 验收资产

- Playwright 主流程放在 `tests/` 的端到端测试目录，覆盖角色导航、重复点击、页面加载/空/错状态和关键玩家/管理流程。
- 每个用户可见迭代在 `tests/manual/<迭代ID>.md` 保存人工验收记录；记录构建/提交标识、浏览器、测试数据、步骤结果和截图/录屏路径。
- 单元、组件或 API 测试通过不能替代页面人工验收；对应页面、Playwright 和人工记录齐备后才满足前端完成定义。

## I06F 已落地基线（2026-07-24）

- 根布局通过 `providers/app-providers.tsx` 装配 TanStack Query、会话恢复和全局通知。access token 只存浏览器内存，refresh token 保持 HttpOnly Cookie；会话恢复经 CSRF Cookie 调用 `/v1/auth/refresh`，不将令牌持久化到 localStorage。
- `api/client.ts` 是统一 contracts 包络和错误适配入口；认证 mutation 生成 `Idempotency-Key`，表单只提交意图并展示服务端错误。
- 公开路由为 `/`、`/login`、`/register`；`(player)` 路由组提供 `/dashboard`；`/admin` 使用独立管理布局。`SessionGate` 仅改善路由体验，管理 API 的 RBAC 仍完全由 Fastify 执行。
- `components/ui.tsx` 提供 Skeleton、错误重试、空态、确认框、分页/筛选和会话过期提示；通用样式由 Tailwind CSS 编译并保留窄屏不阻断的布局。
- Playwright 配置与 I06F 认证用例位于 `tests/e2e/`；真实人工执行记录固定写入 `tests/manual/I06F.md`。

## 不单独建层的内容

- DTO、事件与 API 契约由共享 `packages/contracts` 提供，因此前端不建立会产生重复定义的 `types/` 层。
- 可复用交互逻辑优先归属其业务页面或组件；只有跨多个层且稳定的纯函数才进入 `utils/`，避免过早创建泛化 `hooks/` 层。
- 全局样式和路由框架文件保留在 Next.js 约定的 `app/`；组件私有样式与资源应和所属组件就近放置。静态文件按 Next.js 约定在未来需要时放入 `public/`，它是资源目录而非业务分层。
