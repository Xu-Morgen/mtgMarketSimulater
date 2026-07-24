import { defineConfig } from "vitest/config";

/** Playwright 用例由 `test:e2e` 运行，不能交给 Vitest 收集。 */
export default defineConfig({
  test: {
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**", ".next/**"]
  }
});
