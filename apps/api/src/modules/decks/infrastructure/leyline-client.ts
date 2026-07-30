import { createHash } from "node:crypto";
import { z } from "zod";
import type { DeckCardEntryDto } from "@mtg-market/contracts";
import { encryptJsonPayload } from "../../../shared/security/encrypted-payload.js";
import type { LeylineEvaluation } from "../domain/leyline-evaluation.js";

export const LEYLINE_ADAPTER_VERSION = "leyline-adapter/v2" as const;
// 真实 /api/deck-ranking/analyze 在所有卡牌都可解析时返回 missingCards: null；归一化为领域层的空数组。
const responseSchema = z.object({ scores: z.object({ power: z.number().int().min(0).max(100) }).passthrough(), bracket: z.union([z.number().int().min(1).max(4), z.string().min(1)]).optional(), tiers: z.unknown().optional(), combos: z.unknown().optional(), computedAt: z.string().datetime().optional(), resolvedCount: z.number().int().nonnegative().optional(), missingCards: z.array(z.string()).nullable().optional(), isStale: z.boolean().optional() }).passthrough();
export type { LeylineEvaluation } from "../domain/leyline-evaluation.js";

/** 可安全返回给调用方的 Provider 失败分类；不携带卡表、端点、响应正文或底层错误文本。 */
export type LeylineFailureReason = "timeout" | "network" | "http_status" | "invalid_json" | "invalid_schema" | "unknown";

export class LeylineEvaluationError extends Error {
  constructor(
    readonly reason: LeylineFailureReason,
    readonly attempts: number,
    readonly httpStatus: number | null = null
  ) {
    super(`Leyline 评分不可用：${reason}`);
    this.name = "LeylineEvaluationError";
  }
}

const virtualNames = { plains: "Plains", island: "Island", swamp: "Swamp", mountain: "Mountain", forest: "Forest" } as const;
/** Leyline 输入稳定规范化：指挥官每张单独以 *1 开头，其余按名称排序并合并数量。 */
export function toLeylineDecklist(cards: DeckCardEntryDto[]): string {
  const commanders = cards.filter((card) => card.zone === "commander").map((card) => `*1 ${card.name}`).sort((a, b) => a.localeCompare(b));
  const others = new Map<string, number>();
  for (const card of cards.filter((item) => item.zone !== "commander")) { const name = card.zone === "virtual_basic" ? virtualNames[card.virtualBasic!] : card.name; others.set(name, (others.get(name) ?? 0) + card.quantity); }
  return [...commanders, ...[...others.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, quantity]) => `${quantity} ${name}`)].join("\n");
}

/** 仅由 I25B 报名命令调用；当前草稿 API 不允许触发外部评分。 */
export class LeylineClient {
  constructor(private readonly config: { endpoint: string; timeoutMs: number; maxRetries: number }, private readonly fetcher: typeof fetch = fetch) {}
  async evaluate(cards: DeckCardEntryDto[]): Promise<LeylineEvaluation> {
    const decklistText = toLeylineDecklist(cards); const inputSummarySha256 = createHash("sha256").update(decklistText).digest("hex"); let failure: LeylineEvaluationError | null = null;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) try {
      const signal = AbortSignal.timeout(this.config.timeoutMs); const response = await this.fetcher(this.config.endpoint, { method: "POST", signal, headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ format: "commander", decklistText }) });
      if (!response.ok) throw new LeylineEvaluationError("http_status", attempt + 1, response.status);
      let raw: unknown;
      try { raw = await response.json() as unknown; } catch { throw new LeylineEvaluationError("invalid_json", attempt + 1); }
      const parsed = responseSchema.safeParse(raw); if (!parsed.success) throw new LeylineEvaluationError("invalid_schema", attempt + 1); const data = parsed.data; const rawResponse = raw as Record<string, unknown>; const rawText = JSON.stringify(rawResponse);
      return { score: data.scores.power, providerAlgorithmVersion: "undeclared", decklistText, inputSummarySha256, responseSha256: createHash("sha256").update(rawText).digest("hex"), details: { scores: data.scores as Record<string, unknown>, bracket: data.bracket ?? null, tiers: data.tiers ?? null, combos: data.combos ?? null, computedAt: data.computedAt ?? null, resolvedCount: data.resolvedCount ?? null, missingCards: data.missingCards ?? [], isStale: data.isStale ?? null }, rawResponse };
    } catch (error) { failure = error instanceof LeylineEvaluationError ? error : classifyFailure(error, attempt + 1); }
    throw failure ?? new LeylineEvaluationError("unknown", this.config.maxRetries + 1);
  }
}

function classifyFailure(error: unknown, attempts: number): LeylineEvaluationError {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "TimeoutError" || name === "AbortError" || /\b(timeout|timed out)\b/i.test(message)) return new LeylineEvaluationError("timeout", attempts);
  if (error instanceof TypeError) return new LeylineEvaluationError("network", attempts);
  return new LeylineEvaluationError("unknown", attempts);
}
/** 应用层在同一报名事务内写入密文；返回 nonce/tag 均不进入浏览器。 */
export function encryptLeylineResponse(value: Record<string, unknown>, base64Key: string): { ciphertext: Buffer; nonce: Buffer; tag: Buffer } {
  return encryptJsonPayload(value, base64Key);
}
