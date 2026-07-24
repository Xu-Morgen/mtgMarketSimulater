import Link from "next/link";
export function ForbiddenPage() { return <main className="page status-page"><p className="eyebrow">403</p><h1>无权访问此页面</h1><p>当前账号没有管理员权限。服务器同样会拒绝管理 API 请求。</p><Link className="button" href="/dashboard">返回玩家首页</Link></main>; }
