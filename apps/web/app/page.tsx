import { HealthStatus } from "../components/health-status";

export default function HomePage() {
  return (
    <main>
      <p className="eyebrow">MTG MARKET SIMULATOR</p>
      <h1>卡牌市场模拟器</h1>
      <p className="intro">
        前端已初始化。后续页面将从服务器读取余额、库存、市场、比赛和成就；浏览器不保存任何可结算经济数据。
      </p>
      <section className="grid">
        <article>
          <h2>今日行动</h2>
          <p>领取工作资金、开包、构筑卡组、报名比赛。</p>
        </article>
        <article>
          <h2>市场边界</h2>
          <p>展示 MTGJSON 参考价与游戏内报价，交易结果以服务端结算为准。</p>
        </article>
        <article>
          <h2>服务状态</h2>
          <HealthStatus />
        </article>
      </section>
    </main>
  );
}
