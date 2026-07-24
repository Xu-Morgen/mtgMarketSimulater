import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export default function globalSetup(): void {
  if (process.env.PLAYWRIGHT_EXTERNAL_SERVERS && !process.env.E2E_DATABASE_PATH) return;
  const databasePath = process.env.E2E_DATABASE_PATH ?? "/tmp/mtg-i06f-playwright.db";
  const email = process.env.E2E_ADMIN_EMAIL ?? "admin-e2e@example.test";
  const password = process.env.E2E_ADMIN_PASSWORD ?? "playwright-admin-password-123";
  process.env.E2E_ADMIN_EMAIL = email;
  process.env.E2E_ADMIN_PASSWORD = password;
  execFileSync("pnpm", ["--filter", "@mtg-market/api", "exec", "tsx", "src/tests/fixtures/seed-e2e-admin.ts"], {
    cwd: resolve(process.cwd(), "../.."),
    env: { ...process.env, E2E_DATABASE_PATH: databasePath, E2E_ADMIN_EMAIL: email, E2E_ADMIN_PASSWORD: password },
    stdio: "inherit"
  });
}
