import type Database from "better-sqlite3";
import type { InventoryHoldingDto, PlayerDashboardDto } from "@mtg-market/contracts";
import { DeckService } from "../../decks/application/deck-service.js";
import { TaskService } from "../../growth/application/task-service.js";
import { InventoryService } from "../../inventory/application/inventory-service.js";
import { MarketService } from "../../market/application/market-service.js";
import type { TournamentService } from "../../tournaments/application/tournament-service.js";
import { UserService, type DailyWorkFundingConfig } from "../../users/application/user-service.js";

function sumMinorUnits(values: number[]): number {
  const total = values.reduce((current, value) => current + value, 0);
  if (!Number.isSafeInteger(total)) throw new Error("玩家首页金额超出安全整数范围");
  return total;
}

/**
 * 跨模块首页编排入口。它复用各模块 application 查询，不直接读取其他模块的数据表；
 * 今日赛事沿用 TournamentService 的惰性日模板保障，其他聚合均为只读，浏览器不能自行相加
 * 资产、推导待办资格或判断今日赛事状态。
 */
export class PlayerDashboardService {
  private readonly users: UserService;
  private readonly inventory: InventoryService;
  private readonly decks: DeckService;
  private readonly market: MarketService;

  constructor(
    private readonly tournaments: TournamentService,
    database: Database.Database,
    dailyWorkFundingConfig: DailyWorkFundingConfig,
    timezone: string
  ) {
    this.users = new UserService(database, dailyWorkFundingConfig);
    this.inventory = new InventoryService(database);
    this.decks = new DeckService(database);
    this.market = new MarketService(database);
    this.tasks = new TaskService(database, timezone);
  }

  private readonly tasks: TaskService;

  overview(userId: string, now = new Date()): PlayerDashboardDto | null {
    const archive = this.users.archive(userId);
    if (!archive) return null;

    const holdings = this.allHoldings(userId);
    const valued = holdings.filter((holding) => holding.marketValue !== null);
    const unpricedSkuCount = holdings.length - valued.length;
    const collectionMarketValue = unpricedSkuCount === 0
      ? sumMinorUnits(valued.map((holding) => holding.marketValue!.amount))
      : null;
    const netWorth = collectionMarketValue === null
      ? null
      : { amount: sumMinorUnits([archive.balance.total.amount, collectionMarketValue]), currency: "GAME_CREDIT" as const };
    const dailyWorkFunding = this.users.dailyWorkFundingStatus(userId, now);
    const today = this.tournaments.list(userId, now);
    const decks = this.decks.list(userId);
    const hasValidDeck = decks.some((deck) => deck.legality.valid);
    const todos: PlayerDashboardDto["todos"] = [];
    if (dailyWorkFunding.status === "available") todos.push({ id: "claim_daily_work_funding", label: "领取今日工作资金", href: "/dashboard#daily-work-funding-title" });
    if (holdings.length === 0) todos.push({ id: "acquire_cards", label: "获得第一张卡牌", href: "/packs" });
    if (!hasValidDeck) todos.push({ id: "build_deck", label: "构筑合法 Commander 卡组", href: "/decks/new" });
    if (hasValidDeck && today.some((tournament) => tournament.status === "open" && !tournament.registered)) {
      todos.push({ id: "register_tournament", label: "报名今日比赛", href: "/tournaments" });
    }
    if (this.tasks.overview(userId, now).pendingRewardCount > 0) {
      todos.push({ id: "claim_task_rewards", label: "领取任务中心奖励", href: "/tasks" });
    }

    return {
      balance: archive.balance,
      netWorth,
      collection: {
        distinctSkuCount: holdings.length,
        totalCardCount: sumMinorUnits(holdings.map((holding) => holding.quantity)),
        marketValue: collectionMarketValue === null ? null : { amount: collectionMarketValue, currency: "GAME_CREDIT" },
        unpricedSkuCount
      },
      dailyWorkFunding,
      todayTournaments: {
        availableCount: today.filter((tournament) => tournament.status === "open" && !tournament.registered).length,
        registeredCount: today.filter((tournament) => tournament.registered).length,
        settlingCount: today.filter((tournament) => tournament.status === "settling").length,
        settledCount: today.filter((tournament) => tournament.status === "settled").length
      },
      marketIndex: this.market.index(),
      todos,
      capturedAt: now.toISOString()
    };
  }

  private allHoldings(userId: string): InventoryHoldingDto[] {
    const items: InventoryHoldingDto[] = [];
    let cursor: string | undefined;
    do {
      const page = this.inventory.list(userId, { locked: "any", sort: "updatedAt", direction: "desc", limit: 100, cursor });
      items.push(...page.items);
      cursor = page.page.hasMore ? page.page.nextCursor ?? undefined : undefined;
    } while (cursor);
    return items;
  }
}
