/**
 * I24R 的离线 Commander 强度研究原型。
 *
 * 此模型只读取受控的本地卡牌元数据和规范化卡表；它不读取库存、玩家、余额、环境变量，
 * 也不会联网。分数仅用于研究与未来报名快照候选，不能直接用于任何经济或赛事结算。
 */

export const LOCAL_DECK_POWER_RULE_VERSION = "local-deck-power/v1" as const;
export const LOCAL_DECK_POWER_RULE_VERSION_V2 = "local-deck-power/v2" as const;

export type LocalDeckPowerTag =
  | "efficient-ramp"
  | "card-advantage"
  | "interaction"
  | "tutor"
  | "fast-mana"
  | "combo-piece"
  | "stax-piece"
  | "win-condition";

export interface LocalDeckPowerCardMetadata {
  cardId: string;
  name: string;
  powerTags: LocalDeckPowerTag[];
}

export interface LocalDeckPowerDeckEntry {
  cardId: string;
  quantity: number;
}

export interface LocalDeckPowerInput {
  ruleVersion: string;
  metadataVersion: string;
  cards: LocalDeckPowerCardMetadata[];
  /** 必须是报名命令产出的规范化卡表；本函数仍会排序以确保重放稳定。 */
  normalizedDecklist: LocalDeckPowerDeckEntry[];
}

export interface LocalDeckPowerContribution {
  tag: LocalDeckPowerTag | "base";
  matchedCards: number;
  rawPoints: number;
  cappedPoints: number;
  cap: number | null;
}

export interface LocalDeckPowerResult {
  ruleVersion: string;
  metadataVersion: string;
  score: number;
  inputSummarySha256: string;
  normalizedDecklist: LocalDeckPowerDeckEntry[];
  contributions: LocalDeckPowerContribution[];
}

interface LocalDeckPowerParameter {
  tag: LocalDeckPowerTag;
  pointsPerCard: number;
  cap: number;
}

interface LocalDeckPowerParameters {
  basePoints: number;
  parameters: LocalDeckPowerParameter[];
}

const PARAMETERS: Record<
  typeof LOCAL_DECK_POWER_RULE_VERSION | typeof LOCAL_DECK_POWER_RULE_VERSION_V2,
  LocalDeckPowerParameters
> = {
  [LOCAL_DECK_POWER_RULE_VERSION]: {
    basePoints: 10,
    parameters: [
      { tag: "efficient-ramp", pointsPerCard: 1, cap: 12 },
      { tag: "card-advantage", pointsPerCard: 1, cap: 12 },
      { tag: "interaction", pointsPerCard: 1, cap: 12 },
      { tag: "tutor", pointsPerCard: 6, cap: 24 },
      { tag: "fast-mana", pointsPerCard: 6, cap: 18 },
      { tag: "combo-piece", pointsPerCard: 5, cap: 10 },
      { tag: "stax-piece", pointsPerCard: 4, cap: 12 },
      { tag: "win-condition", pointsPerCard: 3, cap: 9 }
    ]
  },
  /** 仅为参数版本切换和重放测试保留；I24R 没有将它校准为可用策略。 */
  [LOCAL_DECK_POWER_RULE_VERSION_V2]: {
    basePoints: 10,
    parameters: [
      { tag: "efficient-ramp", pointsPerCard: 1, cap: 12 },
      { tag: "card-advantage", pointsPerCard: 1, cap: 12 },
      { tag: "interaction", pointsPerCard: 1, cap: 12 },
      { tag: "tutor", pointsPerCard: 7, cap: 21 },
      { tag: "fast-mana", pointsPerCard: 7, cap: 21 },
      { tag: "combo-piece", pointsPerCard: 5, cap: 10 },
      { tag: "stax-piece", pointsPerCard: 4, cap: 12 },
      { tag: "win-condition", pointsPerCard: 3, cap: 9 }
    ]
  }
};

function nonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new RangeError(`${label}不能为空`);
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label}必须为正安全整数`);
}

function resolveParameters(version: string): LocalDeckPowerParameters {
  if (version === LOCAL_DECK_POWER_RULE_VERSION || version === LOCAL_DECK_POWER_RULE_VERSION_V2)
    return PARAMETERS[version];
  throw new RangeError(`不支持的本地卡组强度规则版本：${version}`);
}

function normalizeDecklist(entries: LocalDeckPowerDeckEntry[]): LocalDeckPowerDeckEntry[] {
  if (entries.length === 0) throw new RangeError("规范化卡表不能为空");
  const byCardId = new Map<string, number>();
  for (const entry of entries) {
    nonEmpty(entry.cardId, "卡牌 ID");
    positiveInteger(entry.quantity, `卡牌 ${entry.cardId} 数量`);
    const next = (byCardId.get(entry.cardId) ?? 0) + entry.quantity;
    if (!Number.isSafeInteger(next))
      throw new RangeError(`卡牌 ${entry.cardId} 数量超出可重放范围`);
    byCardId.set(entry.cardId, next);
  }
  return [...byCardId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cardId, quantity]) => ({ cardId, quantity }));
}

function metadataByCardId(
  cards: LocalDeckPowerCardMetadata[]
): Map<string, LocalDeckPowerCardMetadata> {
  if (cards.length === 0) throw new RangeError("本地卡牌元数据不能为空");
  const byCardId = new Map<string, LocalDeckPowerCardMetadata>();
  for (const card of cards) {
    nonEmpty(card.cardId, "元数据卡牌 ID");
    nonEmpty(card.name, `卡牌 ${card.cardId} 名称`);
    if (byCardId.has(card.cardId)) throw new RangeError(`元数据卡牌 ID 重复：${card.cardId}`);
    const tags = [...card.powerTags].sort();
    if (new Set(tags).size !== tags.length)
      throw new RangeError(`卡牌 ${card.cardId} 的强度标签重复`);
    for (const tag of tags) {
      if (
        !PARAMETERS[LOCAL_DECK_POWER_RULE_VERSION].parameters.some(
          (parameter) => parameter.tag === tag
        )
      ) {
        throw new RangeError(`卡牌 ${card.cardId} 含不支持的强度标签：${tag}`);
      }
    }
    byCardId.set(card.cardId, { ...card, powerTags: tags });
  }
  return byCardId;
}

/**
 * 纯 TypeScript SHA-256：使规则包不依赖 Node、数据库或 HTTP，同时让报名快照可保存
 * 稳定的输入摘要。实现仅用于规范化 ASCII/UTF-8 文本摘要，不处理秘密材料。
 */
function sha256(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]!;
      const right = words[index - 2]!;
      const s0 = ((left >>> 7) | (left << 25)) ^ ((left >>> 18) | (left << 14)) ^ (left >>> 3);
      const s1 =
        ((right >>> 17) | (right << 15)) ^ ((right >>> 19) | (right << 13)) ^ (right >>> 10);
      words[index] = (((words[index - 16]! + s0) | 0) + ((words[index - 7]! + s1) | 0)) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (((((h + s1) | 0) + choice) | 0) + ((constants[index]! + words[index]!) | 0)) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (s0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

/** 对规范化卡表与元数据版本生成未来评分快照使用的 SHA-256 输入摘要。 */
export function localDeckPowerInputSha256(
  input: Pick<LocalDeckPowerInput, "ruleVersion" | "metadataVersion" | "normalizedDecklist">
): string {
  nonEmpty(input.metadataVersion, "元数据版本");
  const decklist = normalizeDecklist(input.normalizedDecklist);
  return sha256(
    `${input.ruleVersion}\n${input.metadataVersion}\n${decklist.map((entry) => `${entry.cardId}:${entry.quantity}`).join("\n")}`
  );
}

/**
 * 输出 0–100 的整数分，并保留每项可解释贡献。标签只可计入所在版本的明确上限，
 * 因而大体量或重复元数据不会导致无界增长。
 */
export function calculateLocalDeckPower(input: LocalDeckPowerInput): LocalDeckPowerResult {
  const parameters = resolveParameters(input.ruleVersion);
  nonEmpty(input.metadataVersion, "元数据版本");
  const decklist = normalizeDecklist(input.normalizedDecklist);
  const metadata = metadataByCardId(input.cards);
  const tags = new Map<LocalDeckPowerTag, number>();
  for (const entry of decklist) {
    const card = metadata.get(entry.cardId);
    if (!card) throw new RangeError(`缺少本地卡牌元数据：${entry.cardId}`);
    for (const tag of card.powerTags) tags.set(tag, (tags.get(tag) ?? 0) + entry.quantity);
  }
  const contributions: LocalDeckPowerContribution[] = [
    {
      tag: "base",
      matchedCards: 0,
      rawPoints: parameters.basePoints,
      cappedPoints: parameters.basePoints,
      cap: null
    }
  ];
  for (const parameter of parameters.parameters) {
    const matchedCards = tags.get(parameter.tag) ?? 0;
    const rawPoints = matchedCards * parameter.pointsPerCard;
    contributions.push({
      tag: parameter.tag,
      matchedCards,
      rawPoints,
      cappedPoints: Math.min(rawPoints, parameter.cap),
      cap: parameter.cap
    });
  }
  const score = Math.min(
    100,
    contributions.reduce((total, contribution) => total + contribution.cappedPoints, 0)
  );
  return {
    ruleVersion: input.ruleVersion,
    metadataVersion: input.metadataVersion,
    score,
    inputSummarySha256: localDeckPowerInputSha256(input),
    normalizedDecklist: decklist,
    contributions
  };
}

export interface LocalDeckPowerComparisonSample {
  id: string;
  localScore: number;
  leylinePower: number;
  metadataComplete: boolean;
}

export interface LocalDeckPowerComparisonResult {
  sampleCount: number;
  coveredCount: number;
  coverageBasisPoints: number;
  meanAbsoluteError: number;
  maxAbsoluteError: number;
  concordantPairs: number;
  comparablePairs: number;
  monotonicityBasisPoints: number;
  lowExtremeMeanAbsoluteError: number | null;
  highExtremeMeanAbsoluteError: number | null;
}

function score0To100(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100)
    throw new RangeError(`${label}必须为 0–100 的安全整数`);
}

/** 对固定 Provider 样本作整数化的覆盖率、误差、单调性和极端组偏差比较。 */
export function compareLocalDeckPower(
  samples: LocalDeckPowerComparisonSample[]
): LocalDeckPowerComparisonResult {
  if (samples.length === 0) throw new RangeError("评分对照样本不能为空");
  const ids = new Set<string>();
  for (const sample of samples) {
    nonEmpty(sample.id, "评分对照样本 ID");
    if (ids.has(sample.id)) throw new RangeError(`评分对照样本 ID 重复：${sample.id}`);
    ids.add(sample.id);
    score0To100(sample.localScore, "本地分数");
    score0To100(sample.leylinePower, "Leyline 分数");
  }
  const covered = samples.filter((sample) => sample.metadataComplete);
  const absoluteErrors = covered.map((sample) => Math.abs(sample.localScore - sample.leylinePower));
  let comparablePairs = 0;
  let concordantPairs = 0;
  for (let left = 0; left < covered.length; left += 1) {
    for (let right = left + 1; right < covered.length; right += 1) {
      const providerDifference = covered[left]!.leylinePower - covered[right]!.leylinePower;
      const localDifference = covered[left]!.localScore - covered[right]!.localScore;
      if (providerDifference === 0 || localDifference === 0) continue;
      comparablePairs += 1;
      if (providerDifference > 0 === localDifference > 0) concordantPairs += 1;
    }
  }
  const meanAbsoluteError =
    absoluteErrors.length === 0
      ? 0
      : Math.round(absoluteErrors.reduce((sum, value) => sum + value, 0) / absoluteErrors.length);
  const meanExtremeError = (selected: LocalDeckPowerComparisonSample[]): number | null =>
    selected.length === 0
      ? null
      : Math.round(
          selected.reduce(
            (sum, sample) => sum + Math.abs(sample.localScore - sample.leylinePower),
            0
          ) / selected.length
        );
  return {
    sampleCount: samples.length,
    coveredCount: covered.length,
    coverageBasisPoints: Math.floor((covered.length * 10_000) / samples.length),
    meanAbsoluteError,
    maxAbsoluteError: absoluteErrors.length === 0 ? 0 : Math.max(...absoluteErrors),
    concordantPairs,
    comparablePairs,
    monotonicityBasisPoints:
      comparablePairs === 0 ? 0 : Math.floor((concordantPairs * 10_000) / comparablePairs),
    lowExtremeMeanAbsoluteError: meanExtremeError(
      covered.filter((sample) => sample.leylinePower <= 25)
    ),
    highExtremeMeanAbsoluteError: meanExtremeError(
      covered.filter((sample) => sample.leylinePower >= 75)
    )
  };
}
