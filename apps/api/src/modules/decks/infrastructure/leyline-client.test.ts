import { describe, expect, it } from "vitest";
import { encryptLeylineResponse, LeylineClient, toLeylineDecklist } from "./leyline-client.js";
import type { LeylineEvaluationError } from "./leyline-client.js";
const cards = [{ zone: "commander" as const, skuId: "a", virtualBasic: null, quantity: 1, name: "Commander", cardIdentity: "c" }, { zone: "main" as const, skuId: "b", virtualBasic: null, quantity: 2, name: "Spell", cardIdentity: "s" }, { zone: "virtual_basic" as const, skuId: null, virtualBasic: "mountain" as const, quantity: 97, name: "山脉", cardIdentity: "virtual:mountain" }];
describe("Leyline 受控适配器", () => {
  it("按稳定 Commander 文本规范化并接受 0 分、缺失卡、null 缺失卡和陈旧响应", async () => { expect(toLeylineDecklist(cards)).toBe("*1 Commander\n97 Mountain\n2 Spell"); const client = new LeylineClient({ endpoint: "https://leyline.test/evaluate", timeoutMs: 1000, maxRetries: 0 }, async () => new Response(JSON.stringify({ scores: { power: 0, speed: 2 }, missingCards: ["Unknown"], isStale: true, resolvedCount: 99 }), { status: 200 })); const result = await client.evaluate(cards); expect(result).toMatchObject({ score: 0, providerAlgorithmVersion: "undeclared", details: { missingCards: ["Unknown"], isStale: true, resolvedCount: 99 } }); const noMissing = new LeylineClient({ endpoint: "https://leyline.test/evaluate", timeoutMs: 1000, maxRetries: 0 }, async () => new Response(JSON.stringify({ scores: { power: 16 }, missingCards: null, isStale: false, resolvedCount: 100 }), { status: 201 })); await expect(noMissing.evaluate(cards)).resolves.toMatchObject({ score: 16, details: { missingCards: [], isStale: false, resolvedCount: 100 } }); });
  it("将 HTTP、JSON、Schema、网络和超时失败归类为可安全诊断信息", async () => {
    const failures: Array<{ fetcher: typeof fetch; reason: LeylineEvaluationError["reason"]; httpStatus: number | null }> = [
      { fetcher: async () => new Response("unavailable", { status: 503 }), reason: "http_status", httpStatus: 503 },
      { fetcher: async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }), reason: "invalid_json", httpStatus: null },
      { fetcher: async () => new Response(JSON.stringify({ scores: { power: 101 } }), { status: 200 }), reason: "invalid_schema", httpStatus: null },
      { fetcher: async () => { throw new TypeError("fetch failed"); }, reason: "network", httpStatus: null },
      { fetcher: async () => { throw new Error("request timed out"); }, reason: "timeout", httpStatus: null }
    ];
    for (const failure of failures) {
      const client = new LeylineClient({ endpoint: "https://leyline.test/evaluate", timeoutMs: 1000, maxRetries: 1 }, failure.fetcher);
      await expect(client.evaluate(cards)).rejects.toMatchObject({ name: "LeylineEvaluationError", reason: failure.reason, httpStatus: failure.httpStatus, attempts: 2 });
    }
    const encrypted = encryptLeylineResponse({ scores: { power: 100 } }, "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="); expect(encrypted).toMatchObject({ nonce: expect.any(Buffer), tag: expect.any(Buffer), ciphertext: expect.any(Buffer) }); expect(encrypted.ciphertext.toString("utf8")).not.toContain("power");
  });
});
