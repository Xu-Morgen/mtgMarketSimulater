import Link from "next/link";

export default function NotFound() { return <main className="page status-page"><h1>页面不存在</h1><p>该地址已失效或尚未开放。</p><Link className="button" href="/">返回首页</Link></main>; }
