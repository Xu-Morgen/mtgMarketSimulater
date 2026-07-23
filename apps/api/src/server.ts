import "dotenv/config";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { calculateNpcQuote } from "@mtg-market/rules";
import { loadApiConfig } from "./config/environment.js";
import { openDatabase } from "./database.js";
import { startTaskRunner } from "./task-runner.js";

const environment = loadApiConfig(process.env);

const database = openDatabase(environment.SQLITE_PATH);
const stopTaskRunner = startTaskRunner(database);
const app = Fastify({ logger: true });

await app.register(cors, { origin: environment.WEB_ORIGIN, credentials: true });

app.get("/health", async () => ({ status: "ok", storage: "sqlite-wal" }));

app.get("/v1/market/quote-preview", async () =>
  calculateNpcQuote({ referencePrice: 10, marketFactor: 1, buySpread: 0.1, sellSpread: 0.1 })
);

const close = async () => {
  stopTaskRunner();
  database.close();
  await app.close();
};

process.once("SIGINT", close);
process.once("SIGTERM", close);

await app.listen({ port: environment.PORT, host: "0.0.0.0" });
