import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

export type ScryfallBulkCard = {
  id: string; set: string; set_name: string; released_at?: string; name: string; collector_number: string;
  oracle_text?: string; rarity?: string; legalities?: Record<string, string>; artist?: string;
  finishes?: string[]; image_uris?: { normal?: string; large?: string };
};

export type ScryfallBulkSource = { version: string; downloadUri: string; cards: ScryfallBulkCard[]; checksumSha256: string };

/** 外部输入适配器：校验 HTTP 状态与 JSON 形状，绝不把 Provider 原始响应暴露给 HTTP 路由。 */
export class ScryfallBulkClient {
  constructor(private readonly endpoint: string, private readonly fetcher: typeof fetch = fetch) {}

  async download(): Promise<ScryfallBulkSource> {
    const descriptor = await this.fetcher(this.endpoint, { headers: { accept: "application/json" } });
    if (!descriptor.ok) throw new Error(`Scryfall Bulk 元数据请求失败：HTTP ${descriptor.status}`);
    const metadata = await descriptor.json() as { updated_at?: unknown; download_uri?: unknown };
    if (typeof metadata.updated_at !== "string" || typeof metadata.download_uri !== "string") throw new Error("Scryfall Bulk 元数据缺少版本或下载地址");
    const response = await this.fetcher(metadata.download_uri);
    if (!response.ok) throw new Error(`Scryfall Bulk 文件下载失败：HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    let cards: unknown;
    try { cards = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Scryfall Bulk 文件损坏或截断，无法解析 JSON"); }
    if (!Array.isArray(cards)) throw new Error("Scryfall Bulk 文件 Schema 无效：根节点必须为数组");
    return { version: metadata.updated_at, downloadUri: metadata.download_uri, cards: cards as ScryfallBulkCard[], checksumSha256: createHash("sha256").update(bytes).digest("hex") };
  }
}

/** 图片仅由任务写入受控目录；返回相对静态路径，避免 URL/路径穿越。 */
export class CatalogImageCache {
  constructor(private readonly rootDirectory: string, private readonly fetcher: typeof fetch = fetch) {}

  async cache(printingId: string, sourceUrl: string): Promise<{ path: string; checksum: string }> {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== "https:") throw new Error("卡图地址必须使用 HTTPS");
    const extension = extname(basename(parsed.pathname)).toLowerCase();
    if (!new Set([".jpg", ".jpeg", ".png", ".webp"]).has(extension)) throw new Error("卡图扩展名不受支持");
    const response = await this.fetcher(sourceUrl);
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
