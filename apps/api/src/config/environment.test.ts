import { describe, expect, it } from "vitest";
import { loadApiConfig } from "./environment.js";

describe("loadApiConfig", () => {
  it("uses safe local defaults", () => {
    expect(loadApiConfig({})).toEqual({
      APP_ENV: "development",
      PORT: 3001,
      SQLITE_PATH: "./data/market-simulator.db",
      WEB_ORIGIN: "http://localhost:3000",
      APP_TIMEZONE: "Asia/Shanghai"
    });
  });

  it("rejects invalid runtime configuration before the server starts", () => {
    expect(() => loadApiConfig({ PORT: "0" })).toThrow();
    expect(() => loadApiConfig({ WEB_ORIGIN: "not-a-url" })).toThrow();
  });
});
