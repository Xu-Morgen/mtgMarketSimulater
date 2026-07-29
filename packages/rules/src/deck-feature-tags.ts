/**
 * I33B 的卡组特征标签层。
 *
 * 该纯函数只将受控本地元数据和规范化卡表转换为可解释的整数特征与特征分；它不产出
 * 最终比赛强度。模拟器和经发布的 ML 模型可消费这些版本化特征校准最终 0–100 分，
 * 而禁牌、赛制和 Bracket 条件仍须由 deck-rules 作为硬性合法性规则处理。
 */

export const DECK_FEATURE_TAG_RULE_VERSION = "deck-feature-tags/v1" as const;

export type DeckFeatureTag =
  | "land"
  | "card-draw"
  | "ramp"
  | "removal"
  | "counterspell"
  | "tutor"
  | "fast-mana"
  | "infinite-combo-piece"
  | "win-condition-piece"
  | "graveyard-interaction"
  | "artifact-interaction"
  | "enchantment-interaction"
  | "explicit-win-route";

export interface DeckFeatureCardMetadata {
  cardId: string;
  /** 法术力值以十分之一为单位，避免浮点曲线特征。地牌为 0。 */
  manaValueTenths: number;
  tags: readonly DeckFeatureTag[];
  /** 同一组内至少两张代表可替代的核心组件。 */
  coreComponentGroups: readonly string[];
  commander: {
    isCommander: boolean;
    isGameChanger: boolean;
    isBanned: boolean;
    hasBracketCondition: boolean;
  };
}

export interface DeckFeatureDeckEntry {
  cardId: string;
  quantity: number;
}

export interface DeckFeatureInput {
  ruleVersion: string;
  cards: DeckFeatureCardMetadata[];
  normalizedDecklist: DeckFeatureDeckEntry[];
}

export interface DeckFeatureContribution {
  feature:
    | "mana-base"
    | "mana-curve"
    | DeckFeatureTag
    | "component-redundancy"
    | "commander-game-changer";
  count: number;
  points: number;
  cap: number;
}

export interface DeckFeatureProfile {
  ruleVersion: string;
  totalCards: number;
  landCount: number;
  /** 以 0、1、2、3、4、5、6、7+ 法术力值分桶；每个数量均为整数。 */
  manaCurve: Array<{ bucket: "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7+"; count: number }>;
  cardDrawCount: number;
  rampCount: number;
  removalCount: number;
  counterspellCount: number;
  tutorCount: number;
  fastManaCount: number;
  infiniteComboPieceCount: number;
  winConditionPieceCount: number;
  graveyardInteractionCount: number;
  artifactInteractionCount: number;
  enchantmentInteractionCount: number;
  redundantCoreComponentGroupCount: number;
  hasExplicitWinRoute: boolean;
  commander: { gameChangerCount: number; bannedCount: number; bracketConditionCount: number };
  /** 供模拟/ML 使用的可解释特征分，不是最终卡组强度。 */
  featureScore: number;
  contributions: DeckFeatureContribution[];
}

const FEATURE_TAGS = new Set<DeckFeatureTag>([
  "land",
  "card-draw",
  "ramp",
  "removal",
  "counterspell",
  "tutor",
  "fast-mana",
  "infinite-combo-piece",
  "win-condition-piece",
  "graveyard-interaction",
  "artifact-interaction",
  "enchantment-interaction",
  "explicit-win-route"
]);

function nonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new RangeError(`${label}不能为空`);
}

function nonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label}必须为非负安全整数`);
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label}必须为正安全整数`);
}

function normalizeDecklist(entries: DeckFeatureDeckEntry[]): DeckFeatureDeckEntry[] {
  if (entries.length === 0) throw new RangeError("规范化卡表不能为空");
  const quantities = new Map<string, number>();
  for (const entry of entries) {
    nonEmpty(entry.cardId, "卡牌 ID");
    positiveSafeInteger(entry.quantity, `卡牌 ${entry.cardId} 数量`);
    const quantity = (quantities.get(entry.cardId) ?? 0) + entry.quantity;
    if (!Number.isSafeInteger(quantity)) throw new RangeError(`卡牌 ${entry.cardId} 数量超出范围`);
    quantities.set(entry.cardId, quantity);
  }
  return [...quantities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cardId, quantity]) => ({ cardId, quantity }));
}

function metadataByCardId(cards: DeckFeatureCardMetadata[]): Map<string, DeckFeatureCardMetadata> {
  if (cards.length === 0) throw new RangeError("本地卡牌元数据不能为空");
  const byCardId = new Map<string, DeckFeatureCardMetadata>();
  for (const card of cards) {
    nonEmpty(card.cardId, "元数据卡牌 ID");
    nonNegativeSafeInteger(card.manaValueTenths, `卡牌 ${card.cardId} 法术力值`);
    if (byCardId.has(card.cardId)) throw new RangeError(`元数据卡牌 ID 重复：${card.cardId}`);
    const tags = [...card.tags].sort();
    if (new Set(tags).size !== tags.length)
      throw new RangeError(`卡牌 ${card.cardId} 的特征标签重复`);
    for (const tag of tags)
      if (!FEATURE_TAGS.has(tag))
        throw new RangeError(`卡牌 ${card.cardId} 含不支持的特征标签：${tag}`);
    const groups = [...card.coreComponentGroups].sort();
    if (new Set(groups).size !== groups.length)
      throw new RangeError(`卡牌 ${card.cardId} 的核心组件组重复`);
    for (const group of groups) nonEmpty(group, `卡牌 ${card.cardId} 核心组件组`);
    byCardId.set(card.cardId, { ...card, tags, coreComponentGroups: groups });
  }
  return byCardId;
}

function manaValueBucket(
  manaValueTenths: number
): DeckFeatureProfile["manaCurve"][number]["bucket"] {
  const manaValue = Math.floor(manaValueTenths / 10);
  if (manaValue >= 7) return "7+";
  return String(manaValue) as "0" | "1" | "2" | "3" | "4" | "5" | "6";
}

function contribution(
  feature: DeckFeatureContribution["feature"],
  count: number,
  pointsPerItem: number,
  cap: number
): DeckFeatureContribution {
  return { feature, count, points: Math.min(count * pointsPerItem, cap), cap };
}

/**
 * 从受控本地元数据提取 ML/模拟可用的特征。`featureScore` 仅表达可解释的特征密度，
 * 不得作为比赛或报名最终强度；`bannedCount` 必须交由合法性规则拒绝。
 */
export function extractDeckFeatures(input: DeckFeatureInput): DeckFeatureProfile {
  if (input.ruleVersion !== DECK_FEATURE_TAG_RULE_VERSION)
    throw new RangeError(`不支持的卡组特征规则版本：${input.ruleVersion}`);
  const decklist = normalizeDecklist(input.normalizedDecklist);
  const metadata = metadataByCardId(input.cards);
  const tagCounts = new Map<DeckFeatureTag, number>();
  const componentGroups = new Map<string, number>();
  const curve = new Map<DeckFeatureProfile["manaCurve"][number]["bucket"], number>([
    ["0", 0],
    ["1", 0],
    ["2", 0],
    ["3", 0],
    ["4", 0],
    ["5", 0],
    ["6", 0],
    ["7+", 0]
  ]);
  let totalCards = 0;
  let gameChangerCount = 0;
  let bannedCount = 0;
  let bracketConditionCount = 0;
  for (const entry of decklist) {
    const card = metadata.get(entry.cardId);
    if (!card) throw new RangeError(`缺少本地卡牌元数据：${entry.cardId}`);
    totalCards += entry.quantity;
    if (!Number.isSafeInteger(totalCards)) throw new RangeError("卡表数量超出范围");
    curve.set(
      manaValueBucket(card.manaValueTenths),
      curve.get(manaValueBucket(card.manaValueTenths))! + entry.quantity
    );
    for (const tag of card.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + entry.quantity);
    for (const group of card.coreComponentGroups)
      componentGroups.set(group, (componentGroups.get(group) ?? 0) + entry.quantity);
    if (card.commander.isCommander) {
      if (card.commander.isGameChanger) gameChangerCount += entry.quantity;
      if (card.commander.isBanned) bannedCount += entry.quantity;
      if (card.commander.hasBracketCondition) bracketConditionCount += entry.quantity;
    }
  }
  const count = (tag: DeckFeatureTag): number => tagCounts.get(tag) ?? 0;
  const landCount = count("land");
  const redundantCoreComponentGroupCount = [...componentGroups.values()].filter(
    (quantity) => quantity >= 2
  ).length;
  const hasExplicitWinRoute =
    count("explicit-win-route") > 0 ||
    (count("infinite-combo-piece") >= 2 && count("win-condition-piece") > 0);
  const manaBasePoints = landCount >= 30 && landCount <= 42 ? 8 : 0;
  const manaCurvePoints =
    curve.get("1")! + curve.get("2")! + curve.get("3")! + curve.get("4")! >= 24 ? 8 : 0;
  const contributions: DeckFeatureContribution[] = [
    { feature: "mana-base", count: landCount, points: manaBasePoints, cap: 8 },
    {
      feature: "mana-curve",
      count: curve.get("1")! + curve.get("2")! + curve.get("3")! + curve.get("4")!,
      points: manaCurvePoints,
      cap: 8
    },
    contribution("card-draw", count("card-draw"), 1, 10),
    contribution("ramp", count("ramp"), 1, 10),
    contribution("removal", count("removal"), 1, 8),
    contribution("counterspell", count("counterspell"), 1, 8),
    contribution("tutor", count("tutor"), 3, 15),
    contribution("fast-mana", count("fast-mana"), 4, 12),
    contribution("infinite-combo-piece", count("infinite-combo-piece"), 3, 10),
    contribution("win-condition-piece", count("win-condition-piece"), 2, 8),
    contribution("graveyard-interaction", count("graveyard-interaction"), 1, 4),
    contribution("artifact-interaction", count("artifact-interaction"), 1, 4),
    contribution("enchantment-interaction", count("enchantment-interaction"), 1, 4),
    contribution("component-redundancy", redundantCoreComponentGroupCount, 3, 9),
    {
      feature: "explicit-win-route",
      count: hasExplicitWinRoute ? 1 : 0,
      points: hasExplicitWinRoute ? 5 : 0,
      cap: 5
    },
    contribution("commander-game-changer", gameChangerCount, 2, 4)
  ];
  return {
    ruleVersion: input.ruleVersion,
    totalCards,
    landCount,
    manaCurve: ["0", "1", "2", "3", "4", "5", "6", "7+"].map((bucket) => ({
      bucket: bucket as DeckFeatureProfile["manaCurve"][number]["bucket"],
      count: curve.get(bucket as DeckFeatureProfile["manaCurve"][number]["bucket"])!
    })),
    cardDrawCount: count("card-draw"),
    rampCount: count("ramp"),
    removalCount: count("removal"),
    counterspellCount: count("counterspell"),
    tutorCount: count("tutor"),
    fastManaCount: count("fast-mana"),
    infiniteComboPieceCount: count("infinite-combo-piece"),
    winConditionPieceCount: count("win-condition-piece"),
    graveyardInteractionCount: count("graveyard-interaction"),
    artifactInteractionCount: count("artifact-interaction"),
    enchantmentInteractionCount: count("enchantment-interaction"),
    redundantCoreComponentGroupCount,
    hasExplicitWinRoute,
    commander: { gameChangerCount, bannedCount, bracketConditionCount },
    featureScore: Math.min(
      100,
      contributions.reduce((total, item) => total + item.points, 0)
    ),
    contributions
  };
}
