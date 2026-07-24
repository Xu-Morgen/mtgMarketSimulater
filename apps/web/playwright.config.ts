import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const apiBaseUrl = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:3001";
const systemChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync));
export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000", screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: systemChromium ? { executablePath: systemChromium } : {} } }, { name: "narrow-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, launchOptions: systemChromium ? { executablePath: systemChromium } : {} } }],
  ...(process.env.PLAYWRIGHT_EXTERNAL_SERVERS ? {} : { webServer: [
    { command: "pnpm --filter @mtg-market/api dev", url: `${apiBaseUrl}/health`, reuseExistingServer: !process.env.CI, env: { ...process.env, PORT: "3001", SQLITE_PATH: "/tmp/mtg-i06f-playwright.db", AUTH_JWT_SECRET: "playwright-only-secret-with-at-least-32-characters", WEB_ORIGIN: "http://localhost:3000", CORS_ORIGINS: "http://localhost:3000" } },
    { command: "pnpm --filter @mtg-market/web dev", url: "http://localhost:3000", reuseExistingServer: !process.env.CI, env: { ...process.env, NEXT_PUBLIC_API_BASE_URL: apiBaseUrl } }
  ] })
});
