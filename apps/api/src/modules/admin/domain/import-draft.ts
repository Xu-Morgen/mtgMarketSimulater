import { createHash } from "node:crypto";
import { canonicalizeRequest, type MtgjsonDraftMappingStatus } from "@mtg-market/contracts";

/**
 * I30B MTGJSON 导入草稿领域纯函数。草稿必须以本地 Scryfall 系列代码和 SKU 映射为准；
 * 缺失、歧义或不受支持工艺均不可发布。校验无副作用、可重放。
 */

export interface SetlistEntry {
  code: string;
  name: string;
  releaseDate: string | null;
}

export interface LocalSetMapping {
  code: string;
  name: string;
}

export interface DraftMappingItem {
  setCode: string;
  name: string;
  status: "importable" | "missing" | "conflict";
  detail: string | null;
}

export interface DraftMappingResult {
  items: DraftMappingItem[];
  importableCount: number;
  missingCount: number;
  conflictCount: number;
  mappingStatus: MtgjsonDraftMappingStatus;
}

/** 校验 SetList 条目；剔除缺失 code/name 的非法项。 */
export function validateSetlistEntries(entries: unknown[]): SetlistEntry[] {
  const result: SetlistEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!code || !name) continue;
    const releaseDate = typeof record.releaseDate === "string" ? record.releaseDate : null;
    result.push({ code, name, releaseDate });
  }
  return result;
}

/**
 * 把 SetList 条目映射到本地 Scryfall 系列代码；可导入=本地存在同 code，
 * 缺失=本地无该 code，冲突=本地存在但名称不一致（歧义）。映射结果决定草稿能否发布。
 */
export function resolveDraftMapping(setlist: SetlistEntry[], localSets: LocalSetMapping[]): DraftMappingResult {
  const localByCode = new Map(localSets.map((set) => [set.code, set.name]));
  let importableCount = 0;
  let missingCount = 0;
  let conflictCount = 0;
  const items: DraftMappingItem[] = setlist.map((entry) => {
    if (!localByCode.has(entry.code)) {
      missingCount += 1;
      return { setCode: entry.code, name: entry.name, status: "missing" as const, detail: "本地目录无该系列代码" };
    }
    if (localByCode.get(entry.code) !== entry.name) {
      conflictCount += 1;
      return { setCode: entry.code, name: entry.name, status: "conflict" as const, detail: "本地同名系列代码与来源名称不一致" };
    }
    importableCount += 1;
    return { setCode: entry.code, name: entry.name, status: "importable" as const, detail: null };
  });
  const mappingStatus: MtgjsonDraftMappingStatus = conflictCount > 0 ? "conflict" : missingCount > 0 ? "missing" : "mapped";
  return { items, importableCount, missingCount, conflictCount, mappingStatus };
}

/** 草稿写请求的幂等指纹。 */
export function importDraftRequestFingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalizeRequest(body)).digest("hex");
}
