import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { chain } from "stream-chain";
import { parser as makeParser } from "stream-json";
import Pick from "stream-json/filters/pick.js";
import StreamValues from "stream-json/streamers/stream-values.js";
import StreamObject from "stream-json/streamers/stream-object.js";
import { createReadStream, createWriteStream, openSync, readSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";

/**
 * 读取文件前两字节判断 gzip 魔数（0x1f 0x8b），返回解压流或直接读取流。
 * 比流式 Transform 内动态切换 gunzip 更可靠——避免手写 Transform + 'data' 事件破坏背压导致死锁。
 * 兼容测试用未压缩 JSON 作 fixture（与原 decode 的字节检测语义一致），同时支持生产 .gz 端点。
 */
function openDecodingStream(filePath: string): Readable {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const head = Buffer.alloc(2);
    const n = readSync(fd, head, 0, 2, 0);
    const isGzip = n >= 2 && head[0] === 0x1f && head[1] === 0x8b;
    const source = createReadStream(filePath);
    return isGzip ? source.pipe(createGunzip()) : source;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

type UnknownRecord = Record<string, unknown>;
export type MappedMtgjsonCard = { scryfallId: string; finish: "nonfoil" | "foil" | "etched"; mtgjsonUuid: string };
export type ChecksumVerification = "verified" | "bypassed";
export type MtgjsonPriceSource = { version: string; pricesUri: string; mappingUri: string; pricesChecksumSha256: string; mappingChecksumSha256: string; checksumVerification: ChecksumVerification; mappings: MappedMtgjsonCard[]; prices: Map<string, { priceType: "normal" | "foil" | "etched"; currency: string; amount: number | null }> };
export type MtgjsonDownloadOptions = { allowChecksumMismatch?: boolean };
export type MtgjsonChecksumFile = "AllPricesToday" | "AllPrintings" | "AllPrices";
/** I17B：AllPrices 历史价格项；同一 UUID+工艺可包含多个自然日正值。 */
export type MtgjsonHistoricalPrice = { priceType: "normal" | "foil" | "etched"; currency: string; date: string; amount: number };
export type MtgjsonAllPricesSource = { version: string; pricesUri: string; pricesChecksumSha256: string; checksumVerification: ChecksumVerification; prices: Map<string, MtgjsonHistoricalPrice[]> };

/** 仅由 application 层映射为稳定失败码；消息不携带外部 URL 或原始响应。 */
export class MtgjsonChecksumMismatchError extends Error {
  readonly code = "CHECKSUM_MISMATCH" as const;
  constructor(
    readonly file: MtgjsonChecksumFile = "AllPricesToday",
    readonly expectedChecksumSha256 = "unavailable",
    readonly actualChecksumSha256 = "unavailable"
  ) { super(`MTGJSON ${file} 文件 checksum 不匹配`); this.name = "MtgjsonChecksumMismatchError"; }
}

function record(value: unknown, message: string): UnknownRecord { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message); return value as UnknownRecord; }
function string(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }

/**
 * MTGJSON 下载与解析全部走流式：边下载边计算 SHA-256 并写入临时文件（单遍、恒定内存），
 * 解析时 `createReadStream → createGunzip → stream-json` 逐对象产出，绝不把整个文件
 * `gunzipSync` + `toString("utf8")`（AllPrices 历史文件会触发 V8 单字符串上限 0x1fffffe8）。
 * 临时文件在解析后 `finally` 删除；失败由 application 层记录失败运行并保留最近成功快照。
 */

const DOWNLOAD_MAX_ATTEMPTS = 3;

/** 下载到临时文件并同步算出原始（gzip）字节的 SHA-256；失败/截断按固定次数重试。 */
async function streamToFile(url: string, userAgent: string, fetcher: typeof fetch): Promise<{ filePath: string; checksum: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetcher(url, { headers: { accept: "application/json", "user-agent": userAgent } });
    if (!response.ok || !response.body) { lastError = new Error(`MTGJSON 下载失败：HTTP ${response.status}`); continue; }
    const filePath = join(tmpdir(), `mtgjson-${randomUUID()}.gz`);
    const hash = createHash("sha256");
    try {
      // web ReadableStream → Node Readable；边写临时文件边把每个 chunk 喂给 hash（单遍、恒定内存）。
      // pipeline 会在流提前结束时 reject（网络截断/连接重置），本次失败、可重试。
      await pipeline(
        Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
        async function* (source) { for await (const chunk of source) { hash.update(chunk); yield chunk; } },
        createWriteStream(filePath)
      );
      return { filePath, checksum: hash.digest("hex") };
    } catch (error) {
      rmSync(filePath, { force: true });
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("MTGJSON 下载失败");
}

async function fetchExpectedChecksum(url: string, userAgent: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(`${url}.sha256`, { headers: { accept: "text/plain", "user-agent": userAgent } });
  if (!response.ok) throw new Error(`MTGJSON checksum 下载失败：HTTP ${response.status}`);
  const expected = (await response.text()).trim().split(/\s+/)[0] ?? "";
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error("MTGJSON checksum 文件格式无效");
  return expected.toLowerCase();
}

/** 校验下载阶段已算出的 checksum 与 provider 发布值；返回 verification 状态。 */
async function verifyChecksum(file: MtgjsonChecksumFile, url: string, actual: string, userAgent: string, fetcher: typeof fetch, options: MtgjsonDownloadOptions): Promise<{ checksum: string; verification: ChecksumVerification }> {
  const expected = await fetchExpectedChecksum(url, userAgent, fetcher);
  if (actual !== expected) {
    if (!options.allowChecksumMismatch) throw new MtgjsonChecksumMismatchError(file, expected, actual);
    return { checksum: actual, verification: "bypassed" };
  }
  return { checksum: actual, verification: "verified" };
}

/** 读取已下载临时文件的 `meta` 子树（小对象，单独一次流），返回 `date ?? version ?? null`。 */
async function readMetaVersion(filePath: string): Promise<string | null> {
  const pipeline = chain([openDecodingStream(filePath), makeParser(), Pick({ filter: "meta" }), StreamValues()]);
  let version: string | null = null;
  pipeline.on("data", (chunk: { value?: UnknownRecord }) => {
    if (version) return;
    const meta = chunk.value;
    if (meta) version = string(meta.date) ?? string(meta.version);
  });
  await new Promise<void>((resolve, reject) => { pipeline.on("end", resolve); pipeline.on("error", reject); });
  return version;
}

/** 从一个 UUID 的价格格式对象里提取 EUR cardmarket retail 子树；非 EUR/缺失返回 null。 */
function extractRetail(formatsValue: unknown): UnknownRecord | null {
  const formats = record(formatsValue, "MTGJSON price formats 无效");
  const paper = record(formats.paper ?? {}, "MTGJSON paper prices 无效");
  const cardmarket = paper.cardmarket;
  if (!cardmarket || typeof cardmarket !== "object" || Array.isArray(cardmarket)) return null;
  const list = cardmarket as UnknownRecord;
  const currency = string(list.currency) ?? "";
  const retail = list.retail;
  if (currency !== "EUR" || !retail || typeof retail !== "object" || Array.isArray(retail)) return null;
  return retail as UnknownRecord;
}

/** AllPricesToday：取某工艺最新（按日期排序）的 EUR retail 正值；无则 null。 */
function latestPrice(retailByFinish: unknown): number | null {
  if (!retailByFinish || typeof retailByFinish !== "object" || Array.isArray(retailByFinish)) return null;
  const entries = Object.entries(retailByFinish as UnknownRecord).filter(([date, amount]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && typeof amount === "number" && Number.isFinite(amount));
  if (!entries.length) return null;
  entries.sort(([left], [right]) => left.localeCompare(right));
  const amount = entries[entries.length - 1]![1];
  return typeof amount === "number" && amount > 0 ? amount : null;
}

/** AllPrices：保留某工艺全部自然日 EUR retail 正值。 */
function historicalPrices(retailByFinish: unknown, priceType: "normal" | "foil" | "etched"): MtgjsonHistoricalPrice[] {
  if (!retailByFinish || typeof retailByFinish !== "object" || Array.isArray(retailByFinish)) return [];
  return Object.entries(retailByFinish as UnknownRecord)
    .filter(([date, amount]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && typeof amount === "number" && Number.isFinite(amount) && amount > 0)
    .map(([date, amount]) => ({ priceType, currency: "EUR", date, amount: amount as number }));
}

/**
 * 流式解析 AllPricesToday/AllPrices 的 data，逐 UUID 产出 `{ uuid, retail }`；恒定内存。
 * 用 `Pick({filter:"data"}) + StreamObject` 保留对象属性名（UUID）作为 key（StreamValues 会丢成数组下标）。
 */
async function* streamPriceDataEntries(filePath: string): AsyncGenerator<{ uuid: string; retail: UnknownRecord }> {
  const pipeline = chain([openDecodingStream(filePath), makeParser(), Pick({ filter: "data" }), StreamObject()]);
  // 直接消费 Readable 的 async iterator：`data` 事件中遇到无 EUR 价格的 UUID 只是跳过该项，
  // 绝不能被误判为整个源流结束。流的结束和解析错误由 async iterator 原样传递。
  for await (const chunk of pipeline as AsyncIterable<{ key: string; value: UnknownRecord }>) {
    const retail = extractRetail(chunk.value);
    if (retail) yield { uuid: chunk.key, retail };
  }
}

/** 外部适配器只产出经过形状、币种与 SHA-256 校验的最小映射/价格输入。 */
export class MtgjsonClient {
  constructor(
    private readonly pricesEndpoint: string,
    private readonly printingsEndpoint: string,
    private readonly userAgent: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly allPricesEndpoint: string | null = null
  ) {}

  async download(options: MtgjsonDownloadOptions = {}): Promise<MtgjsonPriceSource> {
    const [priceFile, mappingFile] = await Promise.all([streamToFile(this.pricesEndpoint, this.userAgent, this.fetcher), streamToFile(this.printingsEndpoint, this.userAgent, this.fetcher)]);
    try {
      const [pricesCheck, mappingCheck] = await Promise.all([
        verifyChecksum("AllPricesToday", this.pricesEndpoint, priceFile.checksum, this.userAgent, this.fetcher, options),
        verifyChecksum("AllPrintings", this.printingsEndpoint, mappingFile.checksum, this.userAgent, this.fetcher, options)
      ]);
      const version = (await readMetaVersion(priceFile.filePath)) ?? "unknown";
      const prices = await this.collectTodayPrices(priceFile.filePath);
      const mappings = await this.collectAllPrintingsMappings(mappingFile.filePath);
      return { version, pricesUri: this.pricesEndpoint, mappingUri: this.printingsEndpoint, pricesChecksumSha256: pricesCheck.checksum, mappingChecksumSha256: mappingCheck.checksum, checksumVerification: pricesCheck.verification === "verified" && mappingCheck.verification === "verified" ? "verified" : "bypassed", mappings, prices };
    } finally {
      rmSync(priceFile.filePath, { force: true });
      rmSync(mappingFile.filePath, { force: true });
    }
  }

  /** I17B：下载并校验完整历史 AllPrices，保留每个 UUID+工艺的全部自然日 EUR retail 正值；不与日常 AllPricesToday 共用指针。 */
  async downloadAllPrices(options: MtgjsonDownloadOptions = {}): Promise<MtgjsonAllPricesSource> {
    if (!this.allPricesEndpoint) throw new Error("未配置 MTGJSON AllPrices 历史端点");
    const file = await streamToFile(this.allPricesEndpoint, this.userAgent, this.fetcher);
    try {
      const check = await verifyChecksum("AllPrices", this.allPricesEndpoint, file.checksum, this.userAgent, this.fetcher, options);
      const version = (await readMetaVersion(file.filePath)) ?? "unknown";
      const prices = await this.collectHistoricalPrices(file.filePath);
      return { version, pricesUri: this.allPricesEndpoint, pricesChecksumSha256: check.checksum, checksumVerification: check.verification, prices };
    } finally {
      rmSync(file.filePath, { force: true });
    }
  }

  /** 流式解析 AllPricesToday：逐 UUID 提取 EUR cardmarket retail 各工艺最新价。 */
  private async collectTodayPrices(filePath: string): Promise<MtgjsonPriceSource["prices"]> {
    const prices = new Map<string, { priceType: "normal" | "foil" | "etched"; currency: string; amount: number | null }>();
    for await (const entry of streamPriceDataEntries(filePath)) {
      for (const finish of ["normal", "foil", "etched"] as const) {
        const amount = latestPrice(entry.retail[finish]);
        if (amount !== null) prices.set(`${entry.uuid}:${finish}`, { priceType: finish, currency: "EUR", amount });
      }
    }
    return prices;
  }

  /** 流式解析 AllPrices：逐 UUID 保留全部自然日 EUR retail 正值。 */
  private async collectHistoricalPrices(filePath: string): Promise<MtgjsonAllPricesSource["prices"]> {
    const prices = new Map<string, MtgjsonHistoricalPrice[]>();
    for await (const entry of streamPriceDataEntries(filePath)) {
      for (const finish of ["normal", "foil", "etched"] as const) {
        const entries = historicalPrices(entry.retail[finish], finish);
        if (entries.length > 0) {
          const key = `${entry.uuid}:${finish}`;
          prices.set(key, [...(prices.get(key) ?? []), ...entries]);
        }
      }
    }
    return prices;
  }

  /**
   * 流式解析 AllPrintings：定位 `data.<set>.cards` 数组，逐卡产出映射。
   * AllPrintings 解压后可能超过 V8 单一字符串限制；流式逐卡 JSON.parse 不触发该上限。
   */
  private async collectAllPrintingsMappings(filePath: string): Promise<MappedMtgjsonCard[]> {
    const mappings: MappedMtgjsonCard[] = [];
    const pipeline = chain([openDecodingStream(filePath), makeParser(), Pick({ filter: /^data\.[^.]+\.cards$/ }), StreamValues()]);
    await new Promise<void>((resolve, reject) => {
      pipeline.on("data", (chunk: { value: unknown }) => {
        if (Array.isArray(chunk.value)) for (const rawCard of chunk.value) appendCardMappings(rawCard, mappings);
      });
      pipeline.on("error", reject);
      pipeline.on("end", resolve);
    });
    if (mappings.length === 0) throw new Error("MTGJSON AllPrintings 缺少 cards");
    return mappings;
  }
}

function appendCardMappings(rawCard: unknown, mappings: MappedMtgjsonCard[]): void {
  const card = record(rawCard, "MTGJSON AllPrintings card 无效");
  const scryfallId = string(record(card.identifiers ?? {}, "MTGJSON identifiers 无效").scryfallId);
  const uuid = string(card.uuid);
  if (!scryfallId || !uuid) return;
  const finishes = Array.isArray(card.finishes) ? card.finishes : [];
  for (const finish of ["nonfoil", "foil", "etched"] as const) if (finishes.includes(finish)) mappings.push({ scryfallId, finish, mtgjsonUuid: uuid });
}
