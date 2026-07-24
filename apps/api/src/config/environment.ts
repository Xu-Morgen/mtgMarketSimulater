import { z } from "zod";

const environmentSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  SQLITE_PATH: z.string().trim().min(1).default("./data/market-simulator.db"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  CORS_ORIGINS: z.string().trim().optional(),
  APP_TIMEZONE: z.string().trim().min(1).default("Asia/Shanghai"),
  AUTH_JWT_SECRET: z.string().min(32).refine((value) => value !== "replace-with-a-random-secret-at-least-32-characters", "AUTH_JWT_SECRET 必须替换示例值"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3_600).max(2_592_000).default(604_800)
  ,CATALOG_DATA_DIR: z.string().trim().min(1).default("./data/catalog")
  ,SCRYFALL_BULK_ENDPOINT: z.string().url().default("https://api.scryfall.com/bulk-data/default-cards")
  ,CATALOG_ENABLED_SET_CODES: z.string().trim().optional()
});

export type ApiConfig = Omit<z.infer<typeof environmentSchema>, "CORS_ORIGINS" | "CATALOG_ENABLED_SET_CODES"> & {
  /** 明确白名单；未列出的浏览器 Origin 不会得到 CORS 响应头。 */
  CORS_ORIGINS: string[];
  /** 空数组表示不导入任何系列，避免意外把完整 Bulk Data 写入小型部署。 */
  CATALOG_ENABLED_SET_CODES: string[];
};

/**
 * 环境变量只在启动边界读取。用例和基础设施通过显式配置接收值，避免在业务代码中
 * 隐式依赖 process.env，也便于测试传入受控配置。
 */
export function loadApiConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  const parsed = environmentSchema.parse(environment);
  const configuredOrigins = parsed.CORS_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean);
  const origins = configuredOrigins?.length ? configuredOrigins : [parsed.WEB_ORIGIN];
  const normalizedOrigins = origins.map((origin) => z.string().url().parse(origin));

  const enabledSets = parsed.CATALOG_ENABLED_SET_CODES?.split(",").map((code) => code.trim().toUpperCase()).filter(Boolean) ?? [];
  return { ...parsed, CORS_ORIGINS: [...new Set(normalizedOrigins)], CATALOG_ENABLED_SET_CODES: [...new Set(enabledSets)] };
}
