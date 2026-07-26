import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

type UnknownRecord = Record<string, unknown>;
export type MappedMtgjsonCard = { scryfallId: string; finish: "nonfoil" | "foil" | "etched"; mtgjsonUuid: string };
export type MtgjsonPriceSource = { version: string; pricesUri: string; mappingUri: string; pricesChecksumSha256: string; mappingChecksumSha256: string; mappings: MappedMtgjsonCard[]; prices: Map<string, { priceType: "normal" | "foil" | "etched"; currency: string; amount: number | null }> };

function record(value: unknown, message: string): UnknownRecord { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message); return value as UnknownRecord; }
function string(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function decode(bytes: Buffer): Buffer { return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes; }
function parseJson(bytes: Buffer, label: string): UnknownRecord { try { return record(JSON.parse(decode(bytes).toString("utf8")), `${label} 根节点必须为对象`); } catch (error) { throw new Error(`${label} 文件损坏或 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`); } }

function allPrintingsMappings(value: UnknownRecord): MappedMtgjsonCard[] {
  const data = record(value.data, "MTGJSON AllPrintings 缺少 data"); const mappings: MappedMtgjsonCard[] = [];
  for (const setValue of Object.values(data)) {
    const set = record(setValue, "MTGJSON AllPrintings set 无效"); const cards = set.cards;
    if (!Array.isArray(cards)) continue;
    for (const rawCard of cards) {
      const card = record(rawCard, "MTGJSON AllPrintings card 无效"); const scryfallId = string(record(card.identifiers ?? {}, "MTGJSON identifiers 无效").scryfallId); const uuid = string(card.uuid);
      if (!scryfallId || !uuid) continue;
      for (const finish of ["nonfoil", "foil", "etched"] as const) {
        const finishes = Array.isArray(card.finishes) ? card.finishes : [];
        if (finishes.includes(finish)) mappings.push({ scryfallId, finish, mtgjsonUuid: uuid });
      }
    }
  }
  return mappings;
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

async function verifyChecksum(url: string, bytes: Buffer, userAgent: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(`${url}.sha256`, { headers: { accept: "text/plain", "user-agent": userAgent } });
  if (!response.ok) throw new Error(`MTGJSON checksum 下载失败：HTTP ${response.status}`);
  const expected = (await response.text()).trim().split(/\s+/)[0] ?? "";
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error("MTGJSON checksum 文件格式无效");
  const actual = createHash("sha256").update(bytes).digest("hex"); if (actual !== expected.toLowerCase()) throw new Error("MTGJSON 文件 checksum 不匹配"); return actual;
}

/** 外部适配器只产出经过形状、币种与 SHA-256 校验的最小映射/价格输入。 */
export class MtgjsonClient {
  constructor(private readonly pricesEndpoint: string, private readonly printingsEndpoint: string, private readonly userAgent: string, private readonly fetcher: typeof fetch = fetch) {}

  async download(): Promise<MtgjsonPriceSource> {
    const [priceBytes, mappingBytes] = await Promise.all([download(this.pricesEndpoint, this.userAgent, this.fetcher), download(this.printingsEndpoint, this.userAgent, this.fetcher)]);
    const [pricesChecksumSha256, mappingChecksumSha256] = await Promise.all([verifyChecksum(this.pricesEndpoint, priceBytes, this.userAgent, this.fetcher), verifyChecksum(this.printingsEndpoint, mappingBytes, this.userAgent, this.fetcher)]);
    const priceJson = parseJson(priceBytes, "MTGJSON AllPricesToday"); const mappingJson = parseJson(mappingBytes, "MTGJSON AllPrintings");
    const meta = record(priceJson.meta ?? {}, "MTGJSON AllPricesToday 缺少 meta"); const version = string(meta.date) ?? string(meta.version) ?? "unknown";
    return { version, pricesUri: this.pricesEndpoint, mappingUri: this.printingsEndpoint, pricesChecksumSha256, mappingChecksumSha256, mappings: allPrintingsMappings(mappingJson), prices: pricesFrom(priceJson) };
  }
}
