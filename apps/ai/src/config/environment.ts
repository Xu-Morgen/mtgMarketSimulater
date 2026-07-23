import { z } from "zod";

const environmentSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_MODEL: z.string().trim().min(1).default("gpt-4.1-mini"),
  AI_DAILY_REQUEST_LIMIT: z.coerce.number().int().positive().default(100)
});

export type AiConfig = z.infer<typeof environmentSchema>;

/** 服务端 AI 配置；此模块不得被 apps/web 引用或暴露给浏览器。 */
export function loadAiConfig(environment: NodeJS.ProcessEnv): AiConfig {
  return environmentSchema.parse(environment);
}
