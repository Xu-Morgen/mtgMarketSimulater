import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadApiConfig } from "../../../config/environment.js";
import { LeylineClient, LeylineEvaluationError } from "./leyline-client.js";
import type { LeylineEvaluation } from "./leyline-client.js";

// 与 API 进程相同地读取 apps/api/.env；不会打印或断言端点、密钥及 Provider 原始响应。
loadDotenv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

const enabled = process.env.LEYLINE_INTEGRATION_TEST === "1";
const integration = enabled ? it : it.skip;
const integrationDeck = [
  { zone: "commander" as const, skuId: "integration-commander", virtualBasic: null, quantity: 1, name: "Atraxa, Praetors' Voice", cardIdentity: "integration:atraxa" },
  { zone: "virtual_basic" as const, skuId: null, virtualBasic: "island" as const, quantity: 99, name: "岛", cardIdentity: "virtual:island" }
];

describe("Leyline 真实端点集成验证", () => {
  integration("读取当前环境的 Leyline 配置，并验证真实响应符合受控评分 Schema", async () => {
    const config = loadApiConfig(process.env);
    const client = new LeylineClient({ endpoint: config.LEYLINE_ENDPOINT, timeoutMs: config.LEYLINE_TIMEOUT_MS, maxRetries: config.LEYLINE_MAX_RETRIES });
    let evaluation: LeylineEvaluation;
    try { evaluation = await client.evaluate(integrationDeck); }
    catch (error) {
      if (error instanceof LeylineEvaluationError) throw new Error(`Leyline 集成测试失败：reason=${error.reason}; attempts=${error.attempts}; httpStatus=${error.httpStatus ?? "none"}`);
      throw error;
    }

    expect(evaluation.score).toBeGreaterThanOrEqual(0);
    expect(evaluation.score).toBeLessThanOrEqual(100);
    expect(evaluation.details.scores).toMatchObject({ power: evaluation.score });
    expect(evaluation.details.missingCards).toEqual(expect.any(Array));
    expect(evaluation.inputSummarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evaluation.responseSha256).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);
});
