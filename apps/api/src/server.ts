import "dotenv/config";
import { createApiApp } from "./app.js";
import { loadApiConfig } from "./config/environment.js";
import { openDatabase } from "./database.js";
import { startTaskRunner } from "./task-runner.js";

const environment = loadApiConfig(process.env);

const database = openDatabase(environment.SQLITE_PATH);
const stopTaskRunner = startTaskRunner(database);
const app = await createApiApp(environment, database);

const close = async () => {
  stopTaskRunner();
  database.close();
  await app.close();
};

process.once("SIGINT", close);
process.once("SIGTERM", close);

await app.listen({ port: environment.PORT, host: "0.0.0.0" });
