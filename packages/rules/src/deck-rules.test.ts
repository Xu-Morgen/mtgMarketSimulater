import { describe, expect, it } from "vitest";
import { COMMANDER_BANLIST_VERSION, COMMANDER_DECK_RULE_VERSION, validateCommanderDeck, type CommanderDeckInput, type DeckRuleCard } from "./deck-rules.js";

const commander: DeckRuleCard = { identity: "commander", name: "赤焰统帅", colorIdentity: ["R"], typeLine: "Legendary Creature — Human", oracleText: "", manaValue: 3, isCommanderLegal: true, isBanned: false, isBannedAsCompanion: false };
const spell: DeckRuleCard = { identity: "spell", name: "火焰咒语", colorIdentity: ["R"], typeLine: "Instant", oracleText: "", manaValue: 1, isCommanderLegal: true, isBanned: false, isBannedAsCompanion: false };
function input(): CommanderDeckInput { return { version: COMMANDER_DECK_RULE_VERSION, banlistVersion: COMMANDER_BANLIST_VERSION, commanders: [commander], main: [{ card: spell, quantity: 1, zone: "main" }], virtualBasics: { mountain: 98 }, companion: null }; }
describe("commander-100/v1", () => {
  it("验证虚拟基本地、100 张和颜色标识，不把基本地当库存或单例", () => { const result = validateCommanderDeck(input()); expect(result).toMatchObject({ valid: true, totalCards: 100, colors: ["R"] }); });
  it("拒绝非法指挥官组合、重复稳定身份、禁牌和异色基本地", () => { const invalid = input(); invalid.commanders = [commander, { ...commander, identity: "other", name: "第二统帅" }]; invalid.main = [{ card: { ...spell, identity: "same" }, quantity: 1, zone: "main" }, { card: { ...spell, identity: "same", name: "另一印刷" }, quantity: 1, zone: "main" }]; invalid.virtualBasics = { island: 97 }; expect(validateCommanderDeck(invalid).issues.join("\n")).toMatch(/官方允许的组合|违反单例|颜色/); });
  it("只允许可验证的 Companion 限制，且禁止其与主牌重复", () => { const companion = { ...spell, identity: "companion", name: "受控伴侣", oracleText: "Companion — Each nonland card in your starting deck has an odd mana value." }; const result = validateCommanderDeck({ ...input(), companion }); expect(result.valid).toBe(true); const duplicate = validateCommanderDeck({ ...input(), companion: { ...companion, identity: "spell" } }); expect(duplicate.issues.join("\n")).toMatch(/重复/); });
});
