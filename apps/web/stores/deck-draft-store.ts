"use client";

import type { DeckCardEntryDto, DeckDto, DeckZone, VirtualBasicLandDto } from "@mtg-market/contracts";
import { create } from "zustand";

type DraftCard = DeckCardEntryDto;
type DeckDraftState = {
  sourceDeckId: string | "new" | null;
  name: string;
  banlistVersion: string | undefined;
  cards: DraftCard[];
  dirty: boolean;
  revision: number;
  initializeNew: () => void;
  initializeFromDeck: (deck: DeckDto) => void;
  setName: (name: string) => void;
  setCardZone: (card: { skuId: string; name: string; cardIdentity: string }, zone: Exclude<DeckZone, "virtual_basic">) => void;
  setQuantity: (identity: string, quantity: number) => void;
  setVirtualBasicQuantity: (basic: VirtualBasicLandDto, quantity: number) => void;
  removeCard: (identity: string) => void;
  markSaved: (deck: DeckDto) => void;
};

function changed(state: Pick<DeckDraftState, "name" | "banlistVersion" | "cards" | "revision">, patch: Partial<Pick<DeckDraftState, "name" | "banlistVersion" | "cards">>) {
  return { ...patch, dirty: true, revision: state.revision + 1 };
}

/** Zustand 仅保留本次编辑尚未提交的卡表，绝不缓存库存、合法性或评分服务器真相。 */
export const useDeckDraftStore = create<DeckDraftState>((set) => ({
  sourceDeckId: null, name: "", banlistVersion: undefined, cards: [], dirty: false, revision: 0,
  initializeNew: () => set((state) => ({ sourceDeckId: "new", name: "", banlistVersion: undefined, cards: [], dirty: false, revision: state.revision + 1 })),
  initializeFromDeck: (deck) => set((state) => ({ sourceDeckId: deck.id, name: deck.name, banlistVersion: deck.banlistVersion, cards: deck.cards, dirty: false, revision: state.revision + 1 })),
  setName: (name) => set((state) => changed(state, { name })),
  setCardZone: (card, zone) => set((state) => {
    const existing = state.cards.find((entry) => entry.skuId === card.skuId);
    const cards = existing
      ? state.cards.map((entry) => entry.skuId === card.skuId ? { ...entry, zone } : entry)
      : [...state.cards, { zone, skuId: card.skuId, virtualBasic: null, quantity: 1, name: card.name, cardIdentity: card.cardIdentity }];
    return changed(state, { cards });
  }),
  setQuantity: (identity, quantity) => set((state) => changed(state, { cards: quantity <= 0 ? state.cards.filter((entry) => `${entry.zone}:${entry.skuId ?? entry.virtualBasic}` !== identity) : state.cards.map((entry) => `${entry.zone}:${entry.skuId ?? entry.virtualBasic}` === identity ? { ...entry, quantity } : entry) })),
  setVirtualBasicQuantity: (basic, quantity) => set((state) => {
    const cards = state.cards.filter((entry) => !(entry.zone === "virtual_basic" && entry.virtualBasic === basic));
    if (quantity > 0) cards.push({ zone: "virtual_basic", skuId: null, virtualBasic: basic, quantity, name: basic, cardIdentity: `virtual:${basic}` });
    return changed(state, { cards });
  }),
  removeCard: (identity) => set((state) => changed(state, { cards: state.cards.filter((entry) => `${entry.zone}:${entry.skuId ?? entry.virtualBasic}` !== identity) })),
  markSaved: (deck) => set((state) => ({ sourceDeckId: deck.id, name: deck.name, banlistVersion: deck.banlistVersion, cards: deck.cards, dirty: false, revision: state.revision + 1 }))
}));
