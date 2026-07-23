import { describe, expect, it } from "vitest";
import { loadAiConfig } from "./environment.js";

describe("loadAiConfig", () => {
  it("allows template-only development without an OpenAI key", () => {
    expect(loadAiConfig({})).toMatchObject({
      APP_ENV: "development",
      OPENAI_MODEL: "gpt-4.1-mini",
      AI_DAILY_REQUEST_LIMIT: 100
    });
  });

  it("rejects an invalid request limit", () => {
    expect(() => loadAiConfig({ AI_DAILY_REQUEST_LIMIT: "0" })).toThrow();
  });
});
