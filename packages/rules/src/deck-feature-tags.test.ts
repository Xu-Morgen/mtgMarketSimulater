import { describe, expect, it } from "vitest";
import {
  DECK_FEATURE_TAG_RULE_VERSION,
  extractDeckFeatures,
  type DeckFeatureCardMetadata
} from "./deck-feature-tags.js";

function cardsFor(
  tag: DeckFeatureCardMetadata["tags"][number],
  count: number,
  prefix: string
): DeckFeatureCardMetadata[] {
  return Array.from({ length: count }, (_, index) => ({
    cardId: `${prefix}-${index + 1}`,
    manaValueTenths: 20,
    tags: [tag],
    coreComponentGroups: [],
    commander: {
      isCommander: false,
      isGameChanger: false,
      isBanned: false,
      hasBracketCondition: false
    }
  }));
}

describe("I33B 卡组特征标签规则", () => {
  it("以整数特征解释资源、互动、组合、冗余、获胜路线与 Commander 条件，而非给出最终强度", () => {
    const cards: DeckFeatureCardMetadata[] = [
      {
        cardId: "commander",
        manaValueTenths: 40,
        tags: ["explicit-win-route"],
        coreComponentGroups: ["route-a"],
        commander: {
          isCommander: true,
          isGameChanger: true,
          isBanned: false,
          hasBracketCondition: true
        }
      },
      ...Array.from({ length: 34 }, (_, index) => ({
        cardId: `land-${index + 1}`,
        manaValueTenths: 0,
          tags: ["land"] as const,
        coreComponentGroups: [],
        commander: {
          isCommander: false,
          isGameChanger: false,
          isBanned: false,
          hasBracketCondition: false
        }
      })),
      ...cardsFor("card-draw", 6, "draw"),
      ...cardsFor("ramp", 8, "ramp"),
      ...cardsFor("removal", 7, "removal"),
      ...cardsFor("counterspell", 5, "counter"),
      ...cardsFor("tutor", 2, "tutor"),
      ...cardsFor("fast-mana", 2, "fast"),
      ...cardsFor("infinite-combo-piece", 2, "combo"),
      ...cardsFor("win-condition-piece", 2, "win"),
      ...cardsFor("graveyard-interaction", 2, "grave"),
      ...cardsFor("artifact-interaction", 2, "artifact"),
      ...cardsFor("enchantment-interaction", 2, "enchantment"),
      {
        cardId: "redundant-a",
        manaValueTenths: 30,
        tags: [],
        coreComponentGroups: ["route-a"],
        commander: {
          isCommander: false,
          isGameChanger: false,
          isBanned: false,
          hasBracketCondition: false
        }
      },
      {
        cardId: "redundant-b",
        manaValueTenths: 30,
        tags: [],
        coreComponentGroups: ["route-a"],
        commander: {
          isCommander: false,
          isGameChanger: false,
          isBanned: false,
          hasBracketCondition: false
        }
      }
    ];
    const profile = extractDeckFeatures({
      ruleVersion: DECK_FEATURE_TAG_RULE_VERSION,
      cards,
      normalizedDecklist: cards.map((card) => ({ cardId: card.cardId, quantity: 1 }))
    });
    expect(profile).toMatchObject({
      landCount: 34,
      cardDrawCount: 6,
      rampCount: 8,
      removalCount: 7,
      counterspellCount: 5,
      tutorCount: 2,
      fastManaCount: 2,
      infiniteComboPieceCount: 2,
      winConditionPieceCount: 2,
      graveyardInteractionCount: 2,
      artifactInteractionCount: 2,
      enchantmentInteractionCount: 2,
      redundantCoreComponentGroupCount: 1,
      hasExplicitWinRoute: true,
      commander: { gameChangerCount: 1, bannedCount: 0, bracketConditionCount: 1 }
    });
    expect(profile.manaCurve.find((bucket) => bucket.bucket === "0")).toEqual({
      bucket: "0",
      count: 34
    });
    expect(profile.featureScore).toBeGreaterThan(0);
    expect(
      profile.contributions.some(
        (item) => item.feature === "explicit-win-route" && item.points === 5
      )
    ).toBe(true);
  });

  it("稳定拒绝未知版本、缺失元数据和非法特征；禁牌只作为合法性硬拒绝信号输出", () => {
    const banned: DeckFeatureCardMetadata = {
      cardId: "banned-commander",
      manaValueTenths: 30,
      tags: [],
      coreComponentGroups: [],
      commander: {
        isCommander: true,
        isGameChanger: false,
        isBanned: true,
        hasBracketCondition: false
      }
    };
    const input = {
      ruleVersion: DECK_FEATURE_TAG_RULE_VERSION,
      cards: [banned],
      normalizedDecklist: [{ cardId: "banned-commander", quantity: 1 }]
    };
    expect(extractDeckFeatures(input).commander.bannedCount).toBe(1);
    expect(() => extractDeckFeatures({ ...input, ruleVersion: "deck-feature-tags/v0" })).toThrow(
      "不支持的卡组特征规则版本"
    );
    expect(() =>
      extractDeckFeatures({ ...input, normalizedDecklist: [{ cardId: "missing", quantity: 1 }] })
    ).toThrow("缺少本地卡牌元数据");
    expect(() =>
      extractDeckFeatures({
        ...input,
        cards: [{ ...banned, tags: ["unsupported" as DeckFeatureCardMetadata["tags"][number]] }]
      })
    ).toThrow("不支持的特征标签");
  });
});
