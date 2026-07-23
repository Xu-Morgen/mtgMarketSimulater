import { z } from "zod";

const environmentSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  SQLITE_PATH: z.string().trim().min(1).default("./data/market-simulator.db"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  APP_TIMEZONE: z.string().trim().min(1).default("Asia/Shanghai")
});

export type ApiConfig = z.infer<typeof environmentSchema>;

/**
 * 环境变量只在启动边界读取。用例和基础设施通过显式配置接收值，避免在业务代码中
 * 隐式依赖 process.env，也便于测试传入受控配置。
 */
export function loadApiConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  return environmentSchema.parse(environment);
}
