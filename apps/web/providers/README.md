# Provider 层（providers）

本层集中装配 React 应用范围的 Provider，并由 `app/layout.tsx` 等框架入口接入。后续包括 TanStack Query 的 `QueryClientProvider`、认证/会话恢复边界、全局通知和必要的主题或动画配置。

Provider 只负责注入上下文、初始化生命周期与跨页面基础设施，不能承载页面业务逻辑、服务器结算规则或可替代的领域组件。服务器真相仍由 `api/` 的 TanStack Query 配置获取；Zustand 只保留 `stores/` 中的临时 UI 状态。

避免在多个页面重复创建 QueryClient、全局监听器或会话恢复逻辑。需要客户端执行的 Provider 应明确标为客户端组件，服务端布局仍保持轻量。
