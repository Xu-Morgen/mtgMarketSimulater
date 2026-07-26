import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

type UnknownRecord = Record<string, unknown>;
export type MappedMtgjsonCard = { scryfallId: string; finish: "nonfoil" | "foil" | "etched"; mtgjsonUuid: string };
export type ChecksumVerification = "verified" | "bypassed";
export type MtgjsonPriceSource = { version: string; pricesUri: string; mappingUri: string; pricesChecksumSha256: string; mappingChecksumSha256: string; checksumVerification: ChecksumVerification; mappings: MappedMtgjsonCard[]; prices: Map<string, { priceType: "normal" | "foil" | "etched"; currency: string; amount: number | null }> };
export type MtgjsonDownloadOptions = { allowChecksumMismatch?: boolean };

/** 仅由 application 层映射为稳定失败码；消息不携带外部 URL 或原始响应。 */
export class MtgjsonChecksumMismatchError extends Error {
  readonly code = "CHECKSUM_MISMATCH" as const;
  constructor() { super("MTGJSON 文件 checksum 不匹配"); }
}

function record(value: unknown, message: string): UnknownRecord { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message); return value as UnknownRecord; }
function string(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function decode(bytes: Buffer): Buffer { return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes; }
function parseJson(bytes: Buffer, label: string): UnknownRecord { try { return record(JSON.parse(decode(bytes).toString("utf8")), `${label} 根节点必须为对象`); } catch (error) { throw new Error(`${label} 文件损坏或 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`); } }

function whitespace(byte: number): boolean { return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09; }
function nextToken(bytes: Buffer, index: number): number { let cursor = index; while (cursor < bytes.length && whitespace(bytes[cursor]!)) cursor += 1; return cursor; }
function stringEnd(bytes: Buffer, start: number): number {
  let cursor = start + 1;
  while (cursor < bytes.length) { if (bytes[cursor] === 0x5c) { cursor += 2; continue; } if (bytes[cursor] === 0x22) return cursor; cursor += 1; }
  throw new Error("JSON 字符串未闭合");
}
function isCardsKey(bytes: Buffer, start: number, end: number): boolean { return end - start === 6 && bytes[start + 1] === 0x63 && bytes[start + 2] === 0x61 && bytes[start + 3] === 0x72 && bytes[start + 4] === 0x64 && bytes[start + 5] === 0x73; }
function objectEnd(bytes: Buffer, start: number): number {
  let depth = 0; let cursor = start;
  while (cursor < bytes.length) {
    const byte = bytes[cursor]!;
    if (byte === 0x22) { cursor = stringEnd(bytes, cursor) + 1; continue; }
    if (byte === 0x7b || byte === 0x5b) depth += 1;
    if (byte === 0x7d || byte === 0x5d) { depth -= 1; if (depth === 0) return cursor; }
    cursor += 1;
  }
  throw new Error("JSON 对象未闭合");
}
function appendCardMappings(rawCard: unknown, mappings: MappedMtgjsonCard[]): void {
  const card = record(rawCard, "MTGJSON AllPrintings card 无效"); const scryfallId = string(record(card.identifiers ?? {}, "MTGJSON identifiers 无效").scryfallId); const uuid = string(card.uuid);
  if (!scryfallId || !uuid) return;
  const finishes = Array.isArray(card.finishes) ? card.finishes : [];
  for (const finish of ["nonfoil", "foil", "etched"] as const) if (finishes.includes(finish)) mappings.push({ scryfallId, finish, mtgjsonUuid: uuid });
}
/** AllPrintings 解压后可能超过 V8 单一字符串限制；只把单张卡对象转换为字符串。 */
function allPrintingsMappings(bytes: Buffer): MappedMtgjsonCard[] {
  try {
    const decoded = decode(bytes); const mappings: MappedMtgjsonCard[] = []; let foundCards = false; let cursor = 0;
    while (cursor < decoded.length) {
      if (decoded[cursor] !== 0x22) { cursor += 1; continue; }
      const end = stringEnd(decoded, cursor); const colon = nextToken(decoded, end + 1);
      if (!isCardsKey(decoded, cursor, end) || decoded[colon] !== 0x3a) { cursor = end + 1; continue; }
      let item = nextToken(decoded, colon + 1); if (decoded[item] !== 0x5b) { cursor = end + 1; continue; }
      foundCards = true; item = nextToken(decoded, item + 1);
      while (item < decoded.length && decoded[item] !== 0x5d) {
        if (decoded[item] !== 0x7b) throw new Error("MTGJSON AllPrintings cards 数组无效");
        const endObject = objectEnd(decoded, item); appendCardMappings(JSON.parse(decoded.subarray(item, endObject + 1).toString("utf8")), mappings);
        item = nextToken(decoded, endObject + 1); if (decoded[item] === 0x2c) item = nextToken(decoded, item + 1); else if (decoded[item] !== 0x5d) throw new Error("MTGJSON AllPrintings cards 分隔符无效");
      }
      cursor = item + 1;
    }
    if (!foundCards) throw new Error("MTGJSON AllPrintings 缺少 cards");
    return mappings;
  } catch (error) { throw new Error(`MTGJSON AllPrintings 文件损坏或 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`); }
}

function latestPrice(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as UnknownRecord).filter(([date, amount]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && typeof amount === "number" && Number.isFinite(amount));
  if (!entries.length) return null; entries.sort(([left], [right]) => left.localeCompare(right));
  const amount = entries[entries.length - 1]![1]; return typeof amount === "number" && amount > 0 ? amount : null;
}

function pricesFrom(value: UnknownRecord): Map<string, { priceType: "normal" | "foil" | "etched"; currency: string; amount: number | null }> {
  const data = record(value.data, "MTGJSON AllPricesToday 缺少 data"); const prices = new Map<string, { priceType: "normal" | "foil" | "etched"; currency: string; amount: number | null }>();
  for (const [uuid, rawFormats] of Object.entries(data)) {
    const formats = record(rawFormats, "MTGJSON price formats 无效"); const paper = record(formats.paper ?? {}, "MTGJSON paper prices 无效"); const cardmarket = paper.cardmarket;
    if (!cardmarket || typeof cardmarket !== "object" || Array.isArray(cardmarket)) continue;
    const list = cardmarket as UnknownRecord; const currency = string(list.currency) ?? ""; const retail = list.retail;
    if (currency !== "EUR" || !retail || typeof retail !== "object" || Array.isArray(retail)) continue;
    for (const [finish, priceType] of [["normal", "normal"], ["foil", "foil"], ["etched", "etched"]] as const) {
      // 一个 MTGJSON SKU UUID 对应一个工艺；保留该 UUID 的匹配工艺价格，冲突由 application 层拒绝映射。
      const amount = latestPrice((retail as UnknownRecord)[finish]);
      if (amount !== null) prices.set(`${uuid}:${priceType}`, { priceType, currency, amount });
    }
  }
  return prices;
}

async function download(url: string, userAgent: string, fetcher: typeof fetch): Promise<Buffer> {
  const response = await fetcher(url, { headers: { accept: "application/json", "user-agent": userAgent } });
  if (!response.ok) throw new Error(`MTGJSON 下载失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length === 0 || bytes.length > 1_200 * 1024 * 1024 * 1024) throw new Error("MTGJSON 文件大小无效"); return bytes;
}

async function verifyChecksum(url: string, bytes: Buffer, userAgent: string, fetcher: typeof fetch, options: MtgjsonDownloadOptions): Promise<{ checksum: string; verification: ChecksumVerification }> {
  const response = await fetcher(`${url}.sha256`, { headers: { accept: "text/plain", "user-agent": userAgent } });
  if (!response.ok) throw new Error(`MTGJSON checksum 下载失败：HTTP ${response.status}`);
  const expected = (await response.text()).trim().split(/\s+/)[0] ?? "";
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error("MTGJSON checksum 文件格式无效");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected.toLowerCase()) {
    if (!options.allowChecksumMismatch) throw new MtgjsonChecksumMismatchError();
    return { checksum: actual, verification: "bypassed" };
  }
  return { checksum: actual, verification: "verified" };
}

/** 外部适配器只产出经过形状、币种与 SHA-256 校验的最小映射/价格输入。 */
export class MtgjsonClient {
  constructor(private readonly pricesEndpoint: string, private readonly printingsEndpoint: string, private readonly userAgent: string, private readonly fetcher: typeof fetch = fetch) {}

  async download(options: MtgjsonDownloadOptions = {}): Promise<MtgjsonPriceSource> {
    const [priceBytes, mappingBytes] = await Promise.all([download(this.pricesEndpoint, this.userAgent, this.fetcher), download(this.printingsEndpoint, this.userAgent, this.fetcher)]);
    const [pricesCheck, mappingCheck] = await Promise.all([verifyChecksum(this.pricesEndpoint, priceBytes, this.userAgent, this.fetcher, options), verifyChecksum(this.printingsEndpoint, mappingBytes, this.userAgent, this.fetcher, options)]);
    const priceJson = parseJson(priceBytes, "MTGJSON AllPricesToday");
    const meta = record(priceJson.meta ?? {}, "MTGJSON AllPricesToday 缺少 meta"); const version = string(meta.date) ?? string(meta.version) ?? "unknown";
    return { version, pricesUri: this.pricesEndpoint, mappingUri: this.printingsEndpoint, pricesChecksumSha256: pricesCheck.checksum, mappingChecksumSha256: mappingCheck.checksum, checksumVerification: pricesCheck.verification === "verified" && mappingCheck.verification === "verified" ? "verified" : "bypassed", mappings: allPrintingsMappings(mappingBytes), prices: pricesFrom(priceJson) };
  }
}
