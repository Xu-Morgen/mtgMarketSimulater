import { describe, expect, it } from "vitest";
import { loadApiConfig } from "./environment.js";

describe("loadApiConfig", () => {
  it("uses safe local defaults", () => {
    expect(loadApiConfig({ AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" })).toEqual({
      APP_ENV: "development",
      PORT: 3001,
      SQLITE_PATH: "./data/market-simulator.db",
      WEB_ORIGIN: "http://localhost:3000",
      CORS_ORIGINS: ["http://localhost:3000"],
      APP_TIMEZONE: "Asia/Shanghai",
      AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters",
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_SECONDS: 604800,
      CATALOG_DATA_DIR: "./data/catalog",
      SCRYFALL_BULK_ENDPOINT: "https://api.scryfall.com/bulk-data/default-cards",
      SCRYFALL_USER_AGENT: "MTG-Market-Simulator/0.1 (local deployment)",
      CATALOG_ENABLED_SET_CODES: []
    });
  });

  it("rejects invalid runtime configuration before the server starts", () => {
    expect(() => loadApiConfig({ AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters", PORT: "0" })).toThrow();
    expect(() => loadApiConfig({ AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters", WEB_ORIGIN: "not-a-url" })).toThrow();
    expect(() => loadApiConfig({})).toThrow();
    expect(() => loadApiConfig({ AUTH_JWT_SECRET: "replace-with-a-random-secret-at-least-32-characters" })).toThrow();
  });

  it("normalizes the explicit CORS allowlist", () => {
    expect(loadApiConfig({ AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters", CORS_ORIGINS: "http://localhost:3000, https://admin.example.test, http://localhost:3000" }).CORS_ORIGINS).toEqual([
      "http://localhost:3000",
      "https://admin.example.test"
    ]);
  });

  it("normalizes enabled Scryfall series without defaulting to a full catalog import", () => {
    expect(loadApiConfig({ AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters", CATALOG_ENABLED_SET_CODES: "one, ONE, bro" }).CATALOG_ENABLED_SET_CODES).toEqual(["ONE", "BRO"]);
  });
});
