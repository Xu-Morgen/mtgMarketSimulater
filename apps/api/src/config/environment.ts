import { z } from "zod";

const defaultDeckResponseEncryptionKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const environmentSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  SQLITE_PATH: z.string().trim().min(1).default("./data/market-simulator.db"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  CORS_ORIGINS: z.string().trim().optional(),
  APP_TIMEZONE: z.string().trim().min(1).refine((value) => {
    try { new Intl.DateTimeFormat("en-CA", { timeZone: value }); return true; } catch { return false; }
  }, "APP_TIMEZONE 必须是有效 IANA 时区").default("Asia/Shanghai"),
  DAILY_WORK_FUNDING_RULE_VERSION: z.string().trim().min(1).default("daily-work-funds/v1"),
  AUTH_JWT_SECRET: z.string().min(32).refine((value) => value !== "replace-with-a-random-secret-at-least-32-characters", "AUTH_JWT_SECRET 必须替换示例值"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3_600).max(2_592_000).default(604_800)
  ,CATALOG_DATA_DIR: z.string().trim().min(1).default("./data/catalog")
  ,SCRYFALL_BULK_ENDPOINT: z.string().url().default("https://api.scryfall.com/bulk-data/default-cards")
  ,SCRYFALL_USER_AGENT: z.string().trim().min(1).max(256).default("MTG-Market-Simulator/0.1 (local deployment)")
  ,CATALOG_ENABLED_SET_CODES: z.string().trim().optional()
  ,MTGJSON_PRICES_ENDPOINT: z.string().url().default("https://mtgjson.com/api/v5/AllPricesToday.json.gz")
  ,MTGJSON_PRINTINGS_ENDPOINT: z.string().url().default("https://mtgjson.com/api/v5/AllPrintings.json.gz")
  ,MTGJSON_ALLPRICES_ENDPOINT: z.string().url().default("https://mtgjson.com/api/v5/AllPrices.json.gz")
  ,MTGJSON_USER_AGENT: z.string().trim().min(1).max(256).default("MTG-Market-Simulator/0.1 (local deployment)")
  ,LEYLINE_ENDPOINT: z.string().url().default("https://api.leyline.gg/v1/evaluate")
  ,LEYLINE_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000)
  ,LEYLINE_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1)
  // 默认值仅便于本地测试；生产部署必须通过受控环境覆盖为随机 32 字节密钥。
  ,DECK_RESPONSE_ENCRYPTION_KEY: z.string().trim().min(43).default(defaultDeckResponseEncryptionKey)
}).superRefine((value, context) => {
  if (Buffer.from(value.DECK_RESPONSE_ENCRYPTION_KEY, "base64").length !== 32) context.addIssue({ code: "custom", path: ["DECK_RESPONSE_ENCRYPTION_KEY"], message: "DECK_RESPONSE_ENCRYPTION_KEY 必须是 32 字节 base64 密钥" });
  if (value.APP_ENV === "production" && value.DECK_RESPONSE_ENCRYPTION_KEY === defaultDeckResponseEncryptionKey) context.addIssue({ code: "custom", path: ["DECK_RESPONSE_ENCRYPTION_KEY"], message: "生产环境必须设置随机 DECK_RESPONSE_ENCRYPTION_KEY" });
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
