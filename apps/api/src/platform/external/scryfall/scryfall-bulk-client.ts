import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { gunzipSync } from "node:zlib";

export type ScryfallBulkCard = {
  id: string; set: string; set_name: string; released_at?: string; name: string; collector_number: string;
  oracle_text?: string; rarity?: string; legalities?: Record<string, string>; artist?: string;
  finishes?: string[]; image_uris?: { normal?: string; large?: string }; card_faces?: Array<{ image_uris?: { normal?: string; large?: string } }>;
};

export type ScryfallBulkSource = { version: string; downloadUri: string; cards: ScryfallBulkCard[]; checksumSha256: string };

/**
 * Bulk 文件很大，不能整体转为 JavaScript string（会超过 Node 的字符串上限）。
 * 这里按字节扫描顶层数组中的对象；对象边界内才单独解码/解析，并可立即丢弃未启用系列。
 */
function parseBulkCards(bytes: Buffer, enabledSetCodes: readonly string[] | undefined): ScryfallBulkCard[] {
  const selected: ScryfallBulkCard[] = []; const enabled = enabledSetCodes ? new Set(enabledSetCodes.map((code) => code.toUpperCase())) : null;
  let index = 0; while (index < bytes.length && (bytes[index] === 0xef || bytes[index] === 0xbb || bytes[index] === 0xbf || bytes[index] === 0x20 || bytes[index] === 0x0a || bytes[index] === 0x0d || bytes[index] === 0x09)) index += 1;
  if (bytes[index] !== 0x5b) throw new Error("Schema 根节点必须为数组");
  let objectStart = -1; let depth = 0; let inString = false; let escaped = false;
  for (index += 1; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (objectStart < 0) { if (byte === 0x7b) { objectStart = index; depth = 1; } continue; }
    if (inString) { if (escaped) escaped = false; else if (byte === 0x5c) escaped = true; else if (byte === 0x22) inString = false; continue; }
    if (byte === 0x22) { inString = true; continue; }
    if (byte === 0x7b || byte === 0x5b) { depth += 1; continue; }
    if (byte === 0x7d || byte === 0x5d) depth -= 1;
    if (depth === 0) {
      const card = JSON.parse(bytes.subarray(objectStart, index + 1).toString("utf8")) as ScryfallBulkCard;
      // 字段缺失的对象也必须交给 application 层报出稳定 Schema 错误，不能被筛选静默吞掉。
      if (!enabled || typeof card.set !== "string" || enabled.has(card.set.toUpperCase())) selected.push(card);
      objectStart = -1;
    }
  }
  if (objectStart >= 0 || inString || depth !== 0) throw new Error("JSON 在对象边界前结束");
  return selected;
}

/** 外部输入适配器：校验 HTTP 状态与 JSON 形状，绝不把 Provider 原始响应暴露给 HTTP 路由。 */
export class ScryfallBulkClient {
  constructor(private readonly endpoint: string, private readonly userAgent: string, private readonly fetcher: typeof fetch = fetch) {}

  async download(enabledSetCodes?: readonly string[]): Promise<ScryfallBulkSource> {
    const descriptor = await this.fetcher(this.endpoint, { headers: { accept: "application/json", "user-agent": this.userAgent } });
    if (!descriptor.ok) throw new Error(`Scryfall Bulk 元数据请求失败：HTTP ${descriptor.status}`);
    const metadata = await descriptor.json() as { updated_at?: unknown; download_uri?: unknown };
    if (typeof metadata.updated_at !== "string" || typeof metadata.download_uri !== "string") throw new Error("Scryfall Bulk 元数据缺少版本或下载地址");
    let lastFailure: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await this.fetcher(metadata.download_uri, { headers: { "user-agent": this.userAgent } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const expectedLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
        if (!response.headers.has("content-encoding") && Number.isSafeInteger(expectedLength) && expectedLength !== bytes.length) throw new Error(`响应长度为 ${bytes.length} 字节，预期 ${expectedLength} 字节`);
        const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
        const cards = parseBulkCards(decoded, enabledSetCodes);
        return { version: metadata.updated_at, downloadUri: metadata.download_uri, cards, checksumSha256: createHash("sha256").update(bytes).digest("hex") };
      } catch (error) {
        lastFailure = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw new Error(`Scryfall Bulk 文件损坏或截断，下载或解析失败（已重试 3 次）：${lastFailure?.message ?? "未知错误"}`);
  }
}

/** 图片仅由任务写入受控目录；返回相对静态路径，避免 URL/路径穿越。 */
export class CatalogImageCache {
  constructor(private readonly rootDirectory: string, private readonly userAgent: string, private readonly fetcher: typeof fetch = fetch) {}

  async cache(printingId: string, sourceUrl: string): Promise<{ path: string; checksum: string }> {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== "https:") throw new Error("卡图地址必须使用 HTTPS");
    const extension = extname(basename(parsed.pathname)).toLowerCase();
    if (!new Set([".jpg", ".jpeg", ".png", ".webp"]).has(extension)) throw new Error("卡图扩展名不受支持");
    const response = await this.fetcher(sourceUrl, { headers: { "user-agent": this.userAgent } });
    if (!response.ok) throw new Error(`卡图下载失败：HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 12 * 1024 * 1024) throw new Error("卡图文件大小无效");
    const filename = `${printingId}${extension}`;
    const imagesDirectory = join(this.rootDirectory, "images");
    mkdirSync(imagesDirectory, { recursive: true });
    writeFileSync(join(imagesDirectory, filename), bytes, { flag: "w" });
    return { path: `images/${filename}`, checksum: createHash("sha256").update(bytes).digest("hex") };
  }
}

export function scryfallPrintingId(cardId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cardId)) throw new Error("Scryfall 卡牌 ID 非法");
  return cardId;
}

/** SKU 无需暴露 Scryfall 复合 ID，重导入时来源键保证已有 SKU 稳定。 */
export function newCatalogId(): string { return randomUUID(); }
