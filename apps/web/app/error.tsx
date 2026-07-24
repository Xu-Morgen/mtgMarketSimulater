"use client";

import { ErrorState } from "../components/ui";

export default function Error({ reset }: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  return <main className="page"><ErrorState title="页面加载失败" onRetry={reset} /></main>;
}
