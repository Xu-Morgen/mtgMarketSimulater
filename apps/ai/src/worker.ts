import "dotenv/config";
import { loadAiConfig } from "./config/environment.js";

const config = loadAiConfig(process.env);

// I01 仅验证 AI 运行环境。持久化任务消费将在 I05 接入 API 的任务注册表。
console.info(
  { appEnv: config.APP_ENV, model: config.OPENAI_MODEL },
  "AI worker configuration valid"
);
