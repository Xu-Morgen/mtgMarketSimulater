import { createHash } from "node:crypto";
import { canonicalizeRequest } from "@mtg-market/contracts";

/**
 * I30B 余额/库存补偿修正领域纯函数。补偿只追加账本/库存流水，绝不直接覆盖最终值；
 * 金额/数量必须为非零安全整数，原因必填。写入由 application 在 SQLite 短事务内完成。
 */

export type CompensationKind = "balance" | "inventory";
export type CompensationDirection = "credit" | "debit";

export interface CompensationInput {
  kind: CompensationKind;
  /** 余额补偿：整数最小货币单位（正数=入账 credit，负数=扣减 debit）；库存补偿：数量 delta（正=增加，负=扣减）。 */
  amount: number;
  reason: string;
  direction: CompensationDirection;
}

export type CompensationValidationCode =
  | "reason_required"
  | "amount_zero"
  | "amount_not_integer"
  | "amount_unsafe"
  | "direction_mismatch";

/** 校验补偿输入；返回错误码列表，空数组表示通过。 */
export function validateCompensationInput(input: CompensationInput): CompensationValidationCode[] {
  const issues: CompensationValidationCode[] = [];
  if (!input.reason || input.reason.trim().length === 0) issues.push("reason_required");
  if (!Number.isSafeInteger(input.amount)) issues.push("amount_not_integer");
  else if (input.amount === 0) issues.push("amount_zero");
  if (!Number.isSafeInteger(input.amount)) issues.push("amount_unsafe");
  if (Number.isSafeInteger(input.amount) && input.amount !== 0) {
    const expected: CompensationDirection = input.amount > 0 ? "credit" : "debit";
    if (input.direction !== expected) issues.push("direction_mismatch");
  }
  return issues;
}

/** 补偿写请求的幂等指纹。 */
export function compensationRequestFingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalizeRequest(body)).digest("hex");
}
