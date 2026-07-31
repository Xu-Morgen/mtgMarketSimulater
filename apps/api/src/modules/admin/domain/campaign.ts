import { createHash } from "node:crypto";
import { canonicalizeRequest, type CampaignScopeType, type CampaignStatus, type CampaignType } from "@mtg-market/contracts";

/**
 * I30B 活动领域纯函数。校验、冲突检测与状态机均无副作用、可重放；
 * 写入由 application 在 SQLite 短事务内完成，绝不在此处触碰数据库。
 */

export interface CampaignDefinitionInput {
  campaignType: CampaignType;
  scopeType: CampaignScopeType;
  scopeId: string | null;
  factorBps: number;
  startsAt: string;
  endsAt: string;
  displayText: string;
  name: string;
  code: string;
  description?: string | null;
  reason?: string | null;
}

export type CampaignValidationCode =
  | "name_required"
  | "code_required"
  | "display_text_required"
  | "unsupported_type"
  | "scope_id_required"
  | "scope_id_forbidden"
  | "factor_out_of_range"
  | "starts_at_required"
  | "ends_at_required"
  | "ends_before_start"
  | "invalid_timestamp";

export interface CampaignConflictCandidate {
  campaignId: string;
  code: string;
  scopeType: CampaignScopeType;
  scopeId: string | null;
  startsAt: string;
  endsAt: string;
}

const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function isIsoTimestamp(value: string): boolean {
  return ISO_TIMESTAMP_REGEX.test(value) && Number.isFinite(Date.parse(value));
}

/** 校验活动定义边界；返回错误码列表，空数组表示通过。 */
export function validateCampaignDefinition(input: CampaignDefinitionInput): CampaignValidationCode[] {
  const issues: CampaignValidationCode[] = [];
  if (!input.name || input.name.trim().length === 0) issues.push("name_required");
  if (!input.code || input.code.trim().length === 0) issues.push("code_required");
  if (!input.displayText || input.displayText.trim().length === 0) issues.push("display_text_required");
  if (input.campaignType !== "market_factor") issues.push("unsupported_type");

  if (input.scopeType === "global") {
    if (input.scopeId !== null && input.scopeId !== undefined) issues.push("scope_id_forbidden");
  } else {
    if (!input.scopeId || input.scopeId.trim().length === 0) issues.push("scope_id_required");
  }

  if (!Number.isSafeInteger(input.factorBps) || input.factorBps < 5000 || input.factorBps > 20000) {
    issues.push("factor_out_of_range");
  }

  if (!input.startsAt) issues.push("starts_at_required");
  else if (!isIsoTimestamp(input.startsAt)) issues.push("invalid_timestamp");
  if (!input.endsAt) issues.push("ends_at_required");
  else if (!isIsoTimestamp(input.endsAt)) issues.push("invalid_timestamp");

  if (isIsoTimestamp(input.startsAt) && isIsoTimestamp(input.endsAt) && Date.parse(input.endsAt) <= Date.parse(input.startsAt)) {
    issues.push("ends_before_start");
  }

  return issues;
}

/**
 * 检测同一作用域与时间区间重叠的已发布/暂停活动；首发活动互斥规则为同 scope+scopeId 且区间相交。
 * 全局活动与任意同 scope_type 的活动均视为冲突。
 */
export function detectCampaignConflicts(
  candidate: { scopeType: CampaignScopeType; scopeId: string | null; startsAt: string; endsAt: string },
  active: CampaignConflictCandidate[]
): CampaignConflictCandidate[] {
  return active.filter((existing) => {
    if (existing.scopeType !== candidate.scopeType) return false;
    if (candidate.scopeType === "global") {
      // 全局活动与所有同 scope_type=global 的活动互斥。
    } else if (existing.scopeId !== candidate.scopeId) {
      return false;
    }
    return Date.parse(candidate.startsAt) < Date.parse(existing.endsAt) && Date.parse(candidate.endsAt) > Date.parse(existing.startsAt);
  });
}

/** 活动状态机：合法迁移返回 true，非法迁移返回 false。 */
export function campaignStatusTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  const allowed: Record<CampaignStatus, CampaignStatus[]> = {
    draft: ["previewing", "published"],
    previewing: ["published", "draft"],
    published: ["paused", "ended"],
    paused: ["published", "ended"],
    ended: []
  };
  return (allowed[from] ?? []).includes(to);
}

/** 活动写请求的幂等指纹；与既有模块的 canonicalizeRequest 模式一致。 */
export function campaignRequestFingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalizeRequest(body)).digest("hex");
}
