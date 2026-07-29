import type Database from "better-sqlite3";
import { withinTransaction } from "@mtg-market/database";
import { resolveDailyWorkFunding } from "@mtg-market/rules";
import { SqliteUserRepository } from "../infrastructure/sqlite-user-repository.js";
import { naturalDateAt } from "../domain/natural-day.js";
import type { DailyWorkFundingConfig } from "./user-service.js";

export interface DailyRolloverPayload {
  naturalDate: string;
  timezone: string;
  workFundingRuleVersion: string;
}

/** 日切只持久化该自然日的资格快照；用户资金始终由显式领取命令入账。 */
export class DailyRolloverService {
  private readonly users: SqliteUserRepository;
  constructor(private readonly database: Database.Database) { this.users = new SqliteUserRepository(database); }

  rollover(payload: DailyRolloverPayload, now = new Date()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.naturalDate)) throw new RangeError("daily.rollover 自然日无效");
    if (!payload.timezone.trim() || !payload.workFundingRuleVersion.trim()) throw new RangeError("daily.rollover 配置无效");
    // 即使管理员误投递了任务，也必须在处理边界拒绝无效 IANA 时区，不能持久化死资格。
    naturalDateAt(now, payload.timezone);
    const funding = resolveDailyWorkFunding(payload.workFundingRuleVersion);
    const openedAt = now.toISOString();
    return withinTransaction(this.database, () => {
      const existing = this.users.findDailyRollover(payload.naturalDate);
      const rollover = this.users.openDailyRollover({ naturalDate: payload.naturalDate, timezone: payload.timezone, ruleVersion: payload.workFundingRuleVersion, amount: funding.amount, openedAt });
      if (!existing) {
        this.users.writeAudit(null, "daily.rollover.opened", "daily_rollover", rollover.id, `job:daily.rollover:${payload.naturalDate}`, {
          naturalDate: rollover.natural_date,
          timezone: rollover.timezone,
          workFundingRuleVersion: rollover.work_funding_rule_version,
          workFundingAmount: rollover.work_funding_amount
        }, openedAt);
      }
      return rollover;
    });
  }
}

/** 调度输入在投递时快照；配置变更不会让已排队任务按错误日期或错误规则运行。 */
export function dailyRolloverPayload(config: DailyWorkFundingConfig, now: Date): DailyRolloverPayload {
  return { naturalDate: naturalDateAt(now, config.timezone), timezone: config.timezone, workFundingRuleVersion: config.ruleVersion };
}
