import Link from "next/link";
import { LoginForm } from "./auth-form";
export function LoginPage() { return <main className="auth-page"><section className="auth-card"><Link className="back-link" href="/">← 返回模拟器说明</Link><p className="eyebrow">账户</p><h1>登录</h1><p>使用你的玩家或管理员账户继续。</p><LoginForm /><p className="auth-switch">还没有账号？<Link href="/register">注册</Link></p></section></main>; }
