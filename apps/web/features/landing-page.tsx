import Link from "next/link";
import { HealthStatus } from "../components/health-status";

export function LandingPage() { return <main className="page landing"><p className="eyebrow">MTG MARKET SIMULATOR</p><h1>卡牌市场模拟器</h1><p className="intro">使用虚拟货币体验卡牌市场。所有余额、库存和交易结果都由服务器保存与结算。</p><div className="actions"><Link className="button" href="/login">登录</Link><Link className="button secondary" href="/register">注册</Link></div><section className="grid"><article><h2>今日行动</h2><p>领取工作资金、开包、构筑卡组、报名比赛。</p></article><article><h2>市场边界</h2><p>展示参考价与游戏内报价，交易结果以服务端结算为准。</p></article><article><h2>服务状态</h2><HealthStatus /></article></section></main>; }
