import {
  calculateLocalDeckPower,
  type LocalDeckPowerCardMetadata,
  type LocalDeckPowerDeckEntry,
  type LocalDeckPowerInput,
  type LocalDeckPowerTag
} from "./local-deck-power.js";

/**
 * I24R 离线评估夹具：仅为受控的合成 Commander 卡池和已保存的脱敏评分响应。
 * 它从不读取用户、库存、余额或报名资料，也不在测试中请求 Leyline。
 */
export const I24R_CONTROLLED_CARD_POOL_VERSION = "i24r-controlled-commander-pool/v1" as const;

export interface SavedLeylineDeckRankingResponse {
  scores: { power: number };
  bracket: string;
  resolvedCount: number;
  missingCards: string[];
  isStale: boolean;
  providerAlgorithmVersion: "undeclared";
}

export interface I24RDeckFixture {
  id: string;
  description: string;
  input: LocalDeckPowerInput;
  savedLeylineResponse: SavedLeylineDeckRankingResponse;
}

function taggedCards(
  deckId: string,
  tag: LocalDeckPowerTag,
  quantity: number
): LocalDeckPowerCardMetadata[] {
  return Array.from({ length: quantity }, (_, index) => ({
    cardId: `${deckId}-${tag}-${String(index + 1).padStart(2, "0")}`,
    name: `研究样本 ${deckId} ${tag} ${index + 1}`,
    powerTags: [tag]
  }));
}

function neutralCards(deckId: string, quantity: number): LocalDeckPowerCardMetadata[] {
  return Array.from({ length: quantity }, (_, index) => ({
    cardId: `${deckId}-neutral-${String(index + 1).padStart(2, "0")}`,
    name: `研究样本 ${deckId} 中性牌 ${index + 1}`,
    powerTags: []
  }));
}

function fixture(
  id: string,
  description: string,
  tags: Partial<Record<LocalDeckPowerTag, number>>,
  savedLeylineResponse: SavedLeylineDeckRankingResponse
): I24RDeckFixture {
  const cards = [...neutralCards(id, 1)];
  for (const tag of Object.keys(tags).sort() as LocalDeckPowerTag[])
    cards.push(...taggedCards(id, tag, tags[tag]!));
  cards.push(...neutralCards(`${id}-fill`, 100 - cards.length));
  const normalizedDecklist: LocalDeckPowerDeckEntry[] = cards.map((card) => ({
    cardId: card.cardId,
    quantity: 1
  }));
  return {
    id,
    description,
    input: {
      ruleVersion: "local-deck-power/v1",
      metadataVersion: I24R_CONTROLLED_CARD_POOL_VERSION,
      cards,
      normalizedDecklist
    },
    savedLeylineResponse
  };
}

export const I24R_DECK_FIXTURES: I24RDeckFixture[] = [
  fixture(
    "starter",
    "低曲线、无快速法术力的入门构筑",
    { "efficient-ramp": 3, "card-advantage": 4, interaction: 5, "win-condition": 2 },
    {
      scores: { power: 22 },
      bracket: "1",
      resolvedCount: 100,
      missingCards: [],
      isStale: false,
      providerAlgorithmVersion: "undeclared"
    }
  ),
  fixture(
    "casual",
    "有基础加速与互动的休闲构筑",
    { "efficient-ramp": 6, "card-advantage": 6, interaction: 7, "win-condition": 3 },
    {
      scores: { power: 34 },
      bracket: "2",
      resolvedCount: 100,
      missingCards: [],
      isStale: false,
      providerAlgorithmVersion: "undeclared"
    }
  ),
  fixture(
    "focused",
    "含检索与组合件的目标明确构筑",
    {
      "efficient-ramp": 9,
      "card-advantage": 8,
      interaction: 8,
      tutor: 1,
      "combo-piece": 2,
      "win-condition": 4
    },
    {
      scores: { power: 58 },
      bracket: "3",
      resolvedCount: 100,
      missingCards: [],
      isStale: false,
      providerAlgorithmVersion: "undeclared"
    }
  ),
  fixture(
    "stax",
    "互动密集、包含税收组件的中高强度构筑",
    {
      "efficient-ramp": 7,
      "card-advantage": 7,
      interaction: 9,
      tutor: 1,
      "combo-piece": 1,
      "stax-piece": 3,
      "win-condition": 3
    },
    {
      scores: { power: 67 },
      bracket: "3",
      resolvedCount: 100,
      missingCards: [],
      isStale: false,
      providerAlgorithmVersion: "undeclared"
    }
  ),
  fixture(
    "high-power",
    "快速法术力、检索和双组合件的高强度构筑",
    {
      "efficient-ramp": 10,
      "card-advantage": 10,
      interaction: 10,
      tutor: 2,
      "fast-mana": 2,
      "combo-piece": 2,
      "stax-piece": 1,
      "win-condition": 4
    },
    {
      scores: { power: 75 },
      bracket: "4",
      resolvedCount: 100,
      missingCards: [],
      isStale: false,
      providerAlgorithmVersion: "undeclared"
    }
  ),
  fixture(
    "competitive",
    "标签密度达到各项上限的竞争级压力样本",
    {
      "efficient-ramp": 12,
      "card-advantage": 12,
      interaction: 12,
      tutor: 4,
      "fast-mana": 3,
      "combo-piece": 3,
      "stax-piece": 2,
      "win-condition": 5
    },
    {
      scores: { power: 92 },
      bracket: "4",
      resolvedCount: 100,
      missingCards: [],
      isStale: false,
      providerAlgorithmVersion: "undeclared"
    }
  )
];

/** 固定样本的可重放本地结果，供 ADR 与单测共用。 */
export const I24R_LOCAL_RESULTS = I24R_DECK_FIXTURES.map((sample) => ({
  id: sample.id,
  result: calculateLocalDeckPower(sample.input),
  leyline: sample.savedLeylineResponse
}));
