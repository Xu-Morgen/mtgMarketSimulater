import { Suspense } from "react";
import { OrdersPage } from "../../../features/orders/orders-page";

/**
 * I18F 我的委托。`useSearchParams` 必须包裹 Suspense，
 * 否则 Next.js 会把整条路由退化为客户端渲染并告警。
 */
export default function Page() {
  return <Suspense fallback={<main className="page" aria-busy="true"><div className="skeleton title" /><div className="skeleton body" /></main>}>
    <OrdersPage />
  </Suspense>;
}
