"use client";

import type { AccountBalanceDto, BatchNpcSellResultDto, DuplicatesSellResultDto, InventoryHoldingDto, NpcBuyPreviewDto, NpcSellPreviewDto, NpcTradeDto, OnboardingTradeOpportunityDto } from "@mtg-market/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";
import { createIdempotencyKey } from "../utils/idempotency";

export type NpcBuyResult = { trade: NpcTradeDto; balance: AccountBalanceDto; holding: InventoryHoldingDto };
type BuyIntent = { key: string; skuId: string; quoteId: string; quoteVersion: string; quantity: number; maxUnitPrice: number };
export type NpcSellResult = { trade: NpcTradeDto; balance: AccountBalanceDto; holding: InventoryHoldingDto };
type SellIntent = { key: string; skuId: string; quoteId: string; quoteVersion: string; quantity: number; minUnitPrice: number };

/** NPC 买入价格、费用和额度始终由服务端预览返回；浏览器只提交该预览的标识与玩家确认的单位限价。 */
export const npcTradeApi = {
  onboardingOpportunity: (accessToken: string) =>
    apiRequest<{ opportunity: OnboardingTradeOpportunityDto }>("/v1/npc-trades/onboarding-opportunity", { accessToken }),
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
    }),
  sellPreview: (accessToken: string, skuId: string, quantity: number | "all") =>
    apiRequest<{ preview: NpcSellPreviewDto }>(`/v1/npc-trades/sell/${skuId}/preview?quantity=${quantity}`, { accessToken }),
  sell: (accessToken: string, input: Omit<SellIntent, "key">, idempotencyKey: string) =>
    apiRequest<NpcSellResult>(`/v1/npc-trades/sell/${input.skuId}`, {
      method: "POST",
      accessToken,
      idempotencyKey,
      body: {
        quoteId: input.quoteId,
        quoteVersion: input.quoteVersion,
        quantity: input.quantity,
        minUnitPrice: input.minUnitPrice
      }
    })
};

/** 服务端为当前新手步骤选择的唯一保底机会；前端不选择 SKU、不计算价格，也不放宽交易资格。 */
export function useOnboardingTradeOpportunityQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["npc-trades", "onboarding-opportunity", user?.id ?? "anonymous"],
    queryFn: () => npcTradeApi.onboardingOpportunity(accessToken!),
    enabled: Boolean(accessToken && user),
    refetchOnMount: "always",
    retry: false
  });
}

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
        void queryClient.invalidateQueries({ queryKey: ["inventory", "available-for-decks", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["market", "quotes", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["market", "quote", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["market", "index", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["prices", "public-status", user.id] });
        // I36F：NPC 成交完成「完成首笔交易」引导步骤（npc.trade.settled 事实推进），引导 Tour 需刷新。
        void queryClient.invalidateQueries({ queryKey: ["onboarding", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["npc-trades", "onboarding-opportunity", user.id] });
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

/** `all` 仍由服务端解析为本次可用库存；浏览器不读取或扣减锁定量。 */
export function useNpcSellPreviewQuery(skuId: string, quantity: number | "all", enabled: boolean) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["npc-trades", "sell-preview", user?.id ?? "anonymous", skuId, quantity],
    queryFn: () => npcTradeApi.sellPreview(accessToken!, skuId, quantity),
    enabled: enabled && Boolean(accessToken && user && skuId && (quantity === "all" || quantity > 0)),
    refetchOnMount: "always",
    retry: false
  });
}

/** 卖出成功后只让服务器真相失效；同一报价确认的网络重试复用同一个幂等键。 */
export function useNpcSellMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const intent = useRef<SellIntent | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: Omit<SellIntent, "key">) => {
      if (
        !intent.current ||
        intent.current.skuId !== input.skuId ||
        intent.current.quoteId !== input.quoteId ||
        intent.current.quoteVersion !== input.quoteVersion ||
        intent.current.quantity !== input.quantity ||
        intent.current.minUnitPrice !== input.minUnitPrice
      ) intent.current = { key: createIdempotencyKey(), ...input };
      return npcTradeApi.sell(accessToken!, input, intent.current.key);
    },
    onSuccess: () => {
      if (user) {
        void queryClient.invalidateQueries({ queryKey: ["archive", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["ledger", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["inventory", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["inventory", "available-for-decks", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["market", "quotes", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["market", "quote", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["market", "index", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["prices", "public-status", user.id] });
        // I36F：NPC 成交完成「完成首笔交易」引导步骤（npc.trade.settled 事实推进），引导 Tour 需刷新。
        void queryClient.invalidateQueries({ queryKey: ["onboarding", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["npc-trades", "onboarding-opportunity", user.id] });
      }
      intent.current = null;
    }
  });
  return { ...mutation, beginNewIntent: () => { intent.current = null; mutation.reset(); } };
}

/** I33B（C8）：重复卡批量卖出；请求体固定为空，只提交意图，逐 SKU 结算由服务端单事务完成。 */
export const duplicatesSellApi = {
  sell: (accessToken: string, idempotencyKey: string) =>
    apiRequest<{ result: DuplicatesSellResultDto }>("/v1/inventory/duplicates/sell", {
      method: "POST",
      body: {},
      accessToken,
      idempotencyKey
    })
};

/**
 * I33F（I33B C8）：重复卡一键清仓。同一意图固定复用同一个幂等键（请求体恒定为空），
 * 网络重试只投递一次；成功后失效库存、账本、图鉴、成就等服务器真相查询。
 */
export function useSellDuplicatesMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const keyRef = useRef<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!keyRef.current) keyRef.current = createIdempotencyKey();
      return duplicatesSellApi.sell(accessToken!, keyRef.current);
    },
    onSuccess: () => {
      if (user) {
        void queryClient.invalidateQueries({ queryKey: ["archive", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["ledger", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["inventory", user.id] });
        // I33F：卖出重复卡会改变收藏图鉴完成度与系列收集率里程碑进度。
        void queryClient.invalidateQueries({ queryKey: ["collection", "album", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["achievements", user.id] });
      }
      keyRef.current = null;
    }
  });
  return {
    ...mutation,
    beginNewIntent: () => {
      keyRef.current = null;
      mutation.reset();
    }
  };
}

/** I34B（D4）：按筛选结果批量向 NPC 卖出；请求体只提交 SKU 意图列表，逐 SKU 结算由服务端单事务完成。 */
export const sellBatchApi = {
  sell: (accessToken: string, skuIds: string[], idempotencyKey: string) =>
    apiRequest<{ result: BatchNpcSellResultDto }>("/v1/npc-trades/sell/batch", {
      method: "POST",
      body: { skuIds },
      accessToken,
      idempotencyKey
    })
};

/**
 * I34F（I34B D4）：按筛选结果批量卖出。同一份 SKU 列表（顺序无关）固定复用同一个幂等键，
 * 网络重试只投递一次；成功后失效库存、账本、市场与价格等服务器真相查询。
 */
export function useSellBatchMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const keyRef = useRef<{ key: string; fingerprint: string } | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: { skuIds: string[] }) => {
      const fingerprint = [...input.skuIds].sort().join(",");
      if (!keyRef.current || keyRef.current.fingerprint !== fingerprint) keyRef.current = { key: createIdempotencyKey(), fingerprint };
      return sellBatchApi.sell(accessToken!, input.skuIds, keyRef.current.key);
    },
    onSuccess: () => {
      if (user) {
        void queryClient.invalidateQueries({ queryKey: ["archive", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["ledger", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["inventory", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["collection", "album", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["market", "quotes", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["market", "index", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["market", "heat", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["prices", "public-status", user.id] });
      }
      keyRef.current = null;
    }
  });
  return {
    ...mutation,
    beginNewIntent: () => {
      keyRef.current = null;
      mutation.reset();
    }
  };
}
