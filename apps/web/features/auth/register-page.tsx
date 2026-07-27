import Link from "next/link";
import { RegisterForm } from "./auth-form";
export function RegisterPage() { return <main className="auth-page"><section className="auth-card"><Link className="back-link" href="/">← 返回模拟器说明</Link><p className="eyebrow">新账户</p><h1>注册</h1><p>注册后将以玩家身份进入模拟器。</p><RegisterForm /><p className="auth-switch">已有账号？<Link href="/login">登录</Link></p></section></main>; }
