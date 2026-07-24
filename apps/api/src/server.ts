import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { createApiApp } from "./app.js";
import { loadApiConfig } from "./config/environment.js";
import { openDatabase } from "./database.js";
import { createTaskRegistry, startTaskRunner } from "./task-runner.js";

// `pnpm dev` 从 workspace 根目录运行；显式定位应用自身的 .env，避免依赖启动 cwd。
loadDotenv({ path: fileURLToPath(new URL("../.env", import.meta.url)) });
const environment = loadApiConfig(process.env);

const database = openDatabase(environment.SQLITE_PATH);
const taskRunner = startTaskRunner(database, 1_000, createTaskRegistry(environment, database));
const app = await createApiApp(environment, database);

const close = async () => {
  await taskRunner.stop();
  await app.close();
  database.close();
};

process.once("SIGINT", close);
process.once("SIGTERM", close);

await app.listen({ port: environment.PORT, host: "0.0.0.0" });
