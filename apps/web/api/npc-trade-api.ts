"use client";

import type { AccountBalanceDto, InventoryHoldingDto, NpcBuyPreviewDto, NpcTradeDto } from "@mtg-market/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";
import { createIdempotencyKey } from "../utils/idempotency";

export type NpcBuyResult = { trade: NpcTradeDto; balance: AccountBalanceDto; holding: InventoryHoldingDto };
type BuyIntent = { key: string; skuId: string; quoteId: string; quoteVersion: string; quantity: number; maxUnitPrice: number };

/** NPC 买入价格、费用和额度始终由服务端预览返回；浏览器只提交该预览的标识与玩家确认的单位限价。 */
export const npcTradeApi = {
  buyPreview: (accessToken: string, skuId: string, quantity: number) =>
    apiRequest<{ preview: NpcBuyPreviewDto }>(`/v1/npc-trades/buy/${skuId}/preview?quantity=${quantity}`, { accessToken }),
  buy: (accessToken: string, input: Omit<BuyIntent, "key">, idempotencyKey: string) =>
    apiRequest<NpcBuyResult>(`/v1/npc-trades/buy/${input.skuId}`, {
      method: "POST",
      accessToken,
      idempotencyKey,
      body: {
        quoteId: input.quoteId,
        quoteVersion: input.quoteVersion,
        quantity: input.quantity,
        maxUnitPrice: input.maxUnitPrice
      }
    })
};

/** 每次提交数量后都强制读取当前服务端预览，不能复用余额、额度或报价版本的旧缓存。 */
export function useNpcBuyPreviewQuery(skuId: string, quantity: number, enabled: boolean) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["npc-trades", "buy-preview", user?.id ?? "anonymous", skuId, quantity],
    queryFn: () => npcTradeApi.buyPreview(accessToken!, skuId, quantity),
    enabled: enabled && Boolean(accessToken && user && skuId && quantity > 0),
    refetchOnMount: "always",
    retry: false
  });
}

/**
 * 网络重试保留同一幂等键；用户重新获取预览后才开始下一次独立的成交意图。
 * 成功只刷新服务器真相的缓存，不在前端推导余额、库存或报价。
 */
export function useNpcBuyMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const intent = useRef<BuyIntent | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: Omit<BuyIntent, "key">) => {
      if (
        !intent.current ||
        intent.current.skuId !== input.skuId ||
        intent.current.quoteId !== input.quoteId ||
        intent.current.quoteVersion !== input.quoteVersion ||
        intent.current.quantity !== input.quantity ||
        intent.current.maxUnitPrice !== input.maxUnitPrice
      ) intent.current = { key: createIdempotencyKey(), ...input };
      return npcTradeApi.buy(accessToken!, input, intent.current.key);
    },
    onSuccess: () => {
      if (user) {
        void queryClient.invalidateQueries({ queryKey: ["archive", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["ledger", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["inventory", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["market", "quotes", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["market", "quote", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["market", "index", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["prices", "public-status", user.id] });
      }
      intent.current = null;
    }
  });
  return {
    ...mutation,
    beginNewIntent: () => {
      intent.current = null;
      mutation.reset();
    }
  };
}
