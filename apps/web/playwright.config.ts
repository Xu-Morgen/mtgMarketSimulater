import { defineConfig, devices } from "@playwright/test";
import { existsSync, rmSync } from "node:fs";

const apiBaseUrl = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:3001";
const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const apiPort = new URL(apiBaseUrl).port || "3001";
const webPort = new URL(webBaseUrl).port || "3000";
// E2E 必须落在隔离的临时库；绝不复用 apps/api/data/market-simulator.db 这类开发或生产库。
const e2eDatabasePath = process.env.E2E_DATABASE_PATH ?? "/tmp/mtg-i06f-playwright.db";
const systemChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync));
export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 30_000,
  // 全量套件会同时运行桌面与窄屏项目。若沿用本机 CPU 数量推导的默认 worker 数，
  // 多个 Chromium 与 Next dev 按需编译会争抢 CPU/内存，连 page.goto/load 和浏览器输入
  // 都可能超过 30s。CI 保持串行，本地限制为 4；命令行 --workers 仍可显式覆盖。
  workers: process.env.CI ? 1 : 4,
  // Next.js dev 模式首次访问路由会按需编译（实测 /catalog 约 4.5s、/inventory 与 /packs 约 2s），
  // 高于 Playwright expect 默认 5s 超时，导致 link.click() 导航后紧跟的断言稳定超时。
  // 提高全局 expect 超时覆盖首次编译窗口；既有 toBeVisible({ timeout: 15_000 }) 显式写法与之同值，互不冲突。
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: webBaseUrl, screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: systemChromium ? { executablePath: systemChromium } : {} } }, { name: "narrow-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, launchOptions: systemChromium ? { executablePath: systemChromium } : {} } }],
  // E2E 绝不复用已在运行的开发服务器：否则 Playwright 会丢弃 env 中的 SQLITE_PATH 覆盖，
  // 注册请求会写入 `pnpm dev:api` 持有的开发库（apps/api/data/market-simulator.db），
  // 污染真实账号。强制 reuseExistingServer:false 使其始终启动绑定到隔离测试库的独立进程；
  // 若端口被 dev 占用会立即报端口冲突，而非静默污染。
  ...(process.env.PLAYWRIGHT_EXTERNAL_SERVERS ? {} : { webServer: (() => {
    // 启动 E2E API 前清空上一次的隔离测试库及其 WAL/SHM，避免跨运行累积脏数据。
    for (const suffix of ["", "-wal", "-shm"]) {
      const candidate = `${e2eDatabasePath}${suffix}`;
      if (candidate !== "" && existsSync(candidate)) {
        try { rmSync(candidate); } catch { /* 只读或不存在则忽略；Playwright 仍会以全新库启动 */ }
      }
    }
    return [
      { command: "pnpm --filter @mtg-market/api dev", url: `${apiBaseUrl}/health`, reuseExistingServer: false, env: { ...process.env, PORT: apiPort, SQLITE_PATH: e2eDatabasePath, AUTH_JWT_SECRET: "playwright-only-secret-with-at-least-32-characters", WEB_ORIGIN: webBaseUrl, CORS_ORIGINS: webBaseUrl } },
      { command: `pnpm --filter @mtg-market/web exec next dev --port ${webPort}`, url: webBaseUrl, reuseExistingServer: false, env: { ...process.env, NEXT_PUBLIC_API_BASE_URL: apiBaseUrl } }
    ];
  })() })
});
