import { z } from "zod";

const environmentSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  SQLITE_PATH: z.string().trim().min(1).default("./data/market-simulator.db"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  CORS_ORIGINS: z.string().trim().optional(),
  APP_TIMEZONE: z.string().trim().min(1).default("Asia/Shanghai")
});

export type ApiConfig = Omit<z.infer<typeof environmentSchema>, "CORS_ORIGINS"> & {
  /** 明确白名单；未列出的浏览器 Origin 不会得到 CORS 响应头。 */
  CORS_ORIGINS: string[];
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

  return { ...parsed, CORS_ORIGINS: [...new Set(normalizedOrigins)] };
}
