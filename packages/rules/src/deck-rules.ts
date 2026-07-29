/** I24B Commander 合法性：此文件仅处理显式元数据，绝不读取数据库或网络。 */
export const COMMANDER_DECK_RULE_VERSION = "commander-100/v1" as const;
export const COMMANDER_BANLIST_VERSION = "commander-banlist/2026-02-09" as const;
export const VIRTUAL_BASIC_LANDS = ["plains", "island", "swamp", "mountain", "forest"] as const;
export type VirtualBasicLand = (typeof VIRTUAL_BASIC_LANDS)[number];
export type ManaColor = "W" | "U" | "B" | "R" | "G";

export interface DeckRuleCard {
  /** 同一 Oracle 卡使用同一 identity，印刷 SKU 不影响单例判断。 */
  identity: string;
  name: string;
  colorIdentity: ManaColor[];
  typeLine: string;
  oracleText: string;
  manaValue: number;
  isCommanderLegal: boolean;
  isBanned: boolean;
  isBannedAsCompanion: boolean;
}
export interface DeckRuleEntry { card: DeckRuleCard; quantity: number; zone: "main" | "commander" | "companion"; }
export interface CommanderDeckInput {
  version: string;
  banlistVersion: string;
  commanders: DeckRuleCard[];
  main: DeckRuleEntry[];
  virtualBasics: Partial<Record<VirtualBasicLand, number>>;
  companion: DeckRuleCard | null;
}
export interface CommanderDeckValidation { valid: boolean; totalCards: number; colors: ManaColor[]; issues: string[]; }

function positive(value: number, label: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} 必须为非负安全整数`); }
function colors(card: DeckRuleCard): ManaColor[] { return [...new Set(card.colorIdentity)].sort() as ManaColor[]; }
function text(card: DeckRuleCard): string { return card.oracleText.toLowerCase(); }
function isCommander(card: DeckRuleCard): boolean {
  return card.isCommanderLegal && (/(legendary\s+(artifact\s+)?creature)/i.test(card.typeLine) || /can be your commander/i.test(card.oracleText));
}
function partnerKind(card: DeckRuleCard): string | null {
  const value = text(card);
  const paired = /partner with ([^.\n]+)/.exec(value);
  if (paired) return `named:${paired[1]!.trim()}`;
  if (/friends forever/.test(value)) return "friends";
  if (/doctor's companion/.test(value)) return "doctor";
  if (/choose a background/.test(value)) return "background";
  if (/^partner(?:\s|$)/m.test(value)) return "partner";
  if (/\bbackground\b/i.test(card.typeLine)) return "background-card";
  if (/\btime lord doctor\b/i.test(card.typeLine)) return "doctor-card";
  return null;
}
function compatiblePair(first: DeckRuleCard, second: DeckRuleCard): boolean {
  const a = partnerKind(first); const b = partnerKind(second);
  if (!a || !b) return false;
  if (a === "partner" && b === "partner") return true;
  if (a === "friends" && b === "friends") return true;
  if (a === "background" && b === "background-card") return true;
  if (b === "background" && a === "background-card") return true;
  if (a === "doctor" && b === "doctor-card") return true;
  if (b === "doctor" && a === "doctor-card") return true;
  return a.startsWith("named:") && b.startsWith("named:") && a.slice(6) === second.name.toLowerCase() && b.slice(6) === first.name.toLowerCase();
}
function companionSatisfied(companion: DeckRuleCard, main: DeckRuleEntry[]): boolean {
  const requirement = text(companion);
  if (!/companion\s*[—-]/.test(requirement)) return false;
  // 已实现官方 Commander 中可以只由受控卡表元数据重放的限制；未知文本宁可拒绝也不默许。
  if (/each permanent card.*mana value 2 or less/.test(requirement)) return main.filter((entry) => /artifact|creature|enchantment|land|planeswalker|battle/i.test(entry.card.typeLine)).every((entry) => entry.card.manaValue <= 2);
  if (/each nonland card.*odd mana value/.test(requirement)) return main.filter((entry) => !/land/i.test(entry.card.typeLine)).every((entry) => entry.card.manaValue % 2 === 1);
  if (/each card.*shares a card type/.test(requirement)) {
    const types = main.map((entry) => new Set(entry.card.typeLine.toLowerCase().split(/[— ]+/).filter((token) => ["artifact", "creature", "enchantment", "instant", "land", "planeswalker", "sorcery", "battle"].includes(token))));
    return types.length > 0 && [...types[0]!].some((kind) => types.every((set) => set.has(kind)));
  }
  return false;
}

/** 返回全部问题而非首个问题，使 API 可提供只读构筑提示。 */
export function validateCommanderDeck(input: CommanderDeckInput): CommanderDeckValidation {
  if (input.version !== COMMANDER_DECK_RULE_VERSION) throw new RangeError(`不支持的卡组规则版本：${input.version}`);
  if (!input.banlistVersion.trim()) throw new RangeError("禁牌表版本不能为空");
  const issues: string[] = [];
  if (input.commanders.length < 1 || input.commanders.length > 2) issues.push("指挥官必须为一张或两张");
  for (const commander of input.commanders) {
    if (!isCommander(commander)) issues.push(`不是合法指挥官：${commander.name}`);
    if (commander.isBanned) issues.push(`禁牌不可作指挥官：${commander.name}`);
  }
  if (input.commanders.length === 2 && !compatiblePair(input.commanders[0]!, input.commanders[1]!)) issues.push("两张指挥官不是官方允许的组合");
  const commanderColors = [...new Set(input.commanders.flatMap(colors))].sort() as ManaColor[];
  const seen = new Set<string>();
  for (const entry of input.main) {
    positive(entry.quantity, `${entry.card.name} 数量`);
    if (entry.quantity === 0) continue;
    if (entry.card.isBanned) issues.push(`禁牌不可加入主牌：${entry.card.name}`);
    if (!colors(entry.card).every((color) => commanderColors.includes(color))) issues.push(`颜色标识不符合指挥官：${entry.card.name}`);
    if (seen.has(entry.card.identity)) issues.push(`违反单例：${entry.card.name}`); else seen.add(entry.card.identity);
    if (entry.quantity !== 1) issues.push(`非基本地牌必须单张：${entry.card.name}`);
  }
  let basics = 0;
  for (const basic of VIRTUAL_BASIC_LANDS) { const quantity = input.virtualBasics[basic] ?? 0; positive(quantity, `${basic} 数量`); basics += quantity; const color = ({ plains: "W", island: "U", swamp: "B", mountain: "R", forest: "G" } as const)[basic]; if (quantity > 0 && !commanderColors.includes(color)) issues.push(`虚拟基本地颜色不符合指挥官：${basic}`); }
  if (input.companion) {
    if (input.companion.isBanned || input.companion.isBannedAsCompanion) issues.push(`Companion 不可用：${input.companion.name}`);
    if (!colors(input.companion).every((color) => commanderColors.includes(color))) issues.push(`Companion 颜色标识不符合指挥官：${input.companion.name}`);
    if (seen.has(input.companion.identity)) issues.push(`Companion 与主牌重复：${input.companion.name}`);
    if (!companionSatisfied(input.companion, input.main)) issues.push(`Companion 限制不满足或不受当前规则支持：${input.companion.name}`);
  }
  const totalCards = input.commanders.length + input.main.reduce((sum, entry) => sum + entry.quantity, 0) + basics;
  if (totalCards !== 100) issues.push(`卡组必须恰好 100 张，当前为 ${totalCards} 张`);
  return { valid: issues.length === 0, totalCards, colors: commanderColors, issues };
}
