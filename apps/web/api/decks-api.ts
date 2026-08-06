"use client";

import type { DeckCardEntryDto, DeckDto, DeckLegalityDto } from "@mtg-market/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useSession } from "../providers/session-provider";
import { createIdempotencyKey } from "../utils/idempotency";
import { apiRequest } from "./client";

export type DeckSaveCardInput =
  | { zone: "commander" | "main" | "companion"; skuId: string; quantity: number }
  | { zone: "virtual_basic"; virtualBasic: "plains" | "island" | "swamp" | "mountain" | "forest"; quantity: number };

export type DeckSaveInput = { name: string; banlistVersion?: string | undefined; cards: DeckSaveCardInput[] };

export const decksApi = {
  list: (accessToken: string) => apiRequest<{ items: DeckDto[] }>("/v1/decks", { accessToken }),
  get: (accessToken: string, deckId: string) => apiRequest<DeckDto>(`/v1/decks/${deckId}`, { accessToken }),
  validate: (accessToken: string, input: DeckSaveInput) => apiRequest<DeckLegalityDto>("/v1/decks/validate", { method: "POST", accessToken, body: input }),
  create: (accessToken: string, input: DeckSaveInput, idempotencyKey: string) => apiRequest<DeckDto>("/v1/decks", { method: "POST", accessToken, idempotencyKey, body: input }),
  update: (accessToken: string, deckId: string, input: DeckSaveInput, idempotencyKey: string) => apiRequest<DeckDto>(`/v1/decks/${deckId}`, { method: "PUT", accessToken, idempotencyKey, body: input })
};

export function useDecksQuery() {
  const { accessToken, user } = useSession();
  return useQuery({ queryKey: ["decks", user?.id ?? "anonymous"], queryFn: () => decksApi.list(accessToken!), enabled: Boolean(accessToken && user), retry: false });
}

export function useDeckQuery(deckId: string | undefined) {
  const { accessToken, user } = useSession();
  return useQuery({ queryKey: ["decks", user?.id ?? "anonymous", deckId], queryFn: () => decksApi.get(accessToken!, deckId!), enabled: Boolean(accessToken && user && deckId), retry: false });
}

/** 合法性检查是服务端只读判断；编辑器不保存或推导 Commander 规则。 */
export function useDeckValidationMutation() {
  const { accessToken } = useSession();
  return useMutation({ mutationFn: (input: DeckSaveInput) => decksApi.validate(accessToken!, input) });
}

/** 同一草稿网络重试复用幂等键；成功后才允许下一次独立保存意图。 */
export function useDeckSaveMutation(deckId: string | undefined) {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  return useMutation({
    mutationFn: async (input: DeckSaveInput) => {
      const fingerprint = JSON.stringify({ deckId: deckId ?? null, input });
      if (!intent.current || intent.current.fingerprint !== fingerprint) intent.current = { fingerprint, key: createIdempotencyKey() };
      return deckId ? decksApi.update(accessToken!, deckId, input, intent.current.key) : decksApi.create(accessToken!, input, intent.current.key);
    },
    onSuccess: ({ data }) => {
      if (user) {
        queryClient.setQueryData(["decks", user.id, data.id], { data });
        void queryClient.invalidateQueries({ queryKey: ["decks", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["onboarding", user.id] });
      }
      intent.current = null;
    }
  });
}

export function toDeckSaveInput(input: { name: string; banlistVersion?: string | undefined; cards: DeckCardEntryDto[] }): DeckSaveInput {
  return {
    name: input.name,
    banlistVersion: input.banlistVersion,
    cards: input.cards.map((card): DeckSaveCardInput => card.zone === "virtual_basic"
      ? { zone: "virtual_basic", virtualBasic: card.virtualBasic!, quantity: card.quantity }
      : { zone: card.zone, skuId: card.skuId!, quantity: card.quantity })
  };
}
