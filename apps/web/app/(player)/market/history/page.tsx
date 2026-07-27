import { Suspense } from "react";
import { PriceHistoryPage } from "../../../../features/market/price-history-page";

/**
 * I17F 价格历史与市场曲线。`useSearchParams` 必须包裹 Suspense，
 * 否则 Next.js 会把整条路由退化为客户端渲染并告警。
 */
export default function Page() {
  return <Suspense fallback={<main className="page" aria-busy="true"><div className="skeleton title" /><div className="skeleton body" /></main>}>
    <PriceHistoryPage />
  </Suspense>;
}
