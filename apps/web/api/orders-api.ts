"use client";

import type {
  AccountBalanceDto,
  BilateralOrderBookDto,
  BilateralOrderDto,
  BilateralOrderPreviewDto,
  BilateralTradeDto,
  OrderSide,
  OrderStatus,
  Page,
  PlayerBilateralTradeDto
} from "@mtg-market/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";
import { createIdempotencyKey } from "../utils/idempotency";

export type OrdersFilters = {
  status?: OrderStatus | undefined;
  side?: OrderSide | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

/** 玩家成交只读过滤；skuId 可选，cursor/limit 控制分页。 */
export type PlayerTradesFilters = {
  skuId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

/**
 * 创建委托的玩家经济输入只有数量与限价；报价标识、规则版本、限价带、费用、保证金、
 * 预计金额和有效期全部来自服务端预览，且必须原样回传，浏览器不重算或编造。
 */
export type OrderCreateInput = {
  skuId: string;
  quoteId: string;
  quoteVersion: string;
  previewVersion: string;
  quantity: number;
  limitPrice: number;
};

type CreateIntent = { key: string } & OrderCreateInput;

function listQueryString(filters: OrdersFilters): string {
  const parameters = new URLSearchParams({ limit: String(filters.limit ?? 20) });
  if (filters.status) parameters.set("status", filters.status);
  if (filters.side) parameters.set("side", filters.side);
  if (filters.cursor) parameters.set("cursor", filters.cursor);
  return parameters.toString();
}

/** 委托预览、创建、列表、详情、撤单与只读订单簿的唯一前端入口；不复制任何结算规则。 */
export const bilateralOrderApi = {
  buyPreview: (accessToken: string, skuId: string, quantity: number) =>
    apiRequest<{ preview: BilateralOrderPreviewDto }>(`/v1/orders/buy/${skuId}/preview?quantity=${quantity}`, { accessToken }),
  sellPreview: (accessToken: string, skuId: string, quantity: number) =>
    apiRequest<{ preview: BilateralOrderPreviewDto }>(`/v1/orders/sell/${skuId}/preview?quantity=${quantity}`, { accessToken }),
  create: (accessToken: string, side: OrderSide, input: OrderCreateInput, idempotencyKey: string) =>
    apiRequest<{ order: BilateralOrderDto }>(`/v1/orders/${side}/${input.skuId}`, {
      method: "POST",
      accessToken,
      idempotencyKey,
      body: {
        quoteId: input.quoteId,
        quoteVersion: input.quoteVersion,
        previewVersion: input.previewVersion,
        quantity: input.quantity,
        limitPrice: input.limitPrice
      }
    }),
  list: (accessToken: string, filters: OrdersFilters) =>
    apiRequest<Page<BilateralOrderDto>>(`/v1/orders?${listQueryString(filters)}`, { accessToken }),
  find: (accessToken: string, orderId: string) =>
    apiRequest<{ order: BilateralOrderDto }>(`/v1/orders/${orderId}`, { accessToken }),
  cancel: (accessToken: string, orderId: string, idempotencyKey: string) =>
    apiRequest<{ order: BilateralOrderDto }>(`/v1/orders/${orderId}/cancel`, { method: "POST", accessToken, idempotencyKey }),
  book: (accessToken: string, skuId: string) =>
    apiRequest<{ book: BilateralOrderBookDto }>(`/v1/orders/book/${skuId}`, { accessToken }),
  trades: (accessToken: string, filters: PlayerTradesFilters) =>
    apiRequest<Page<PlayerBilateralTradeDto>>(`/v1/orders/trades?${tradesQueryString(filters)}`, { accessToken }),
  // I20B 履约/取消履约请求体为空，幂等键指纹仅依赖路径与动作；trade 为服务端脱敏成交，balance 为请求者视角。
  fulfillTrade: (accessToken: string, tradeId: string, idempotencyKey: string) =>
    apiRequest<{ trade: BilateralTradeDto; balance: AccountBalanceDto }>(`/v1/orders/trades/${tradeId}/fulfill`, { method: "POST", accessToken, idempotencyKey }),
  cancelTrade: (accessToken: string, tradeId: string, idempotencyKey: string) =>
    apiRequest<{ trade: BilateralTradeDto; balance: AccountBalanceDto }>(`/v1/orders/trades/${tradeId}/cancel`, { method: "POST", accessToken, idempotencyKey })
};

function tradesQueryString(filters: PlayerTradesFilters): string {
  const parameters = new URLSearchParams({ limit: String(filters.limit ?? 20) });
  if (filters.skuId) parameters.set("skuId", filters.skuId);
  if (filters.cursor) parameters.set("cursor", filters.cursor);
  return parameters.toString();
}

/** 每次数量或方向变化都强制重新读取当前服务端预览，不能复用旧报价版本或限价带。 */
export function useOrderPreviewQuery(skuId: string, side: OrderSide, quantity: number, enabled: boolean) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["orders", "preview", user?.id ?? "anonymous", skuId, side, quantity],
    queryFn: () => (side === "buy" ? bilateralOrderApi.buyPreview(accessToken!, skuId, quantity) : bilateralOrderApi.sellPreview(accessToken!, skuId, quantity)),
    enabled: enabled && Boolean(accessToken && user && skuId && quantity > 0),
    refetchOnMount: "always",
    retry: false
  });
}

/**
 * 同一 `quoteId/quoteVersion/previewVersion/quantity/limitPrice` 的网络重试复用幂等键；
 * 任一变化（含重新预览得到新的 previewVersion）才生成新键。
 * 成功只失效服务器真相缓存，不在前端推导余额、库存或报价。
 */
export function useCreateOrderMutation(side: OrderSide) {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const intent = useRef<CreateIntent | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: OrderCreateInput) => {
      if (
        !intent.current ||
        intent.current.skuId !== input.skuId ||
        intent.current.quoteId !== input.quoteId ||
        intent.current.quoteVersion !== input.quoteVersion ||
        intent.current.previewVersion !== input.previewVersion ||
        intent.current.quantity !== input.quantity ||
        intent.current.limitPrice !== input.limitPrice
      ) intent.current = { key: createIdempotencyKey(), ...input };
      return bilateralOrderApi.create(accessToken!, side, input, intent.current.key);
    },
    onSuccess: () => {
      if (user) {
        void queryClient.invalidateQueries({ queryKey: ["orders", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["orders", "preview", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["orders", "book", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["orders", "trades", user.id] });
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

/** 我的委托按当前用户与 URL 筛选隔离；只读服务端订单状态，不修改状态机。 */
export function useOrdersQuery(filters: OrdersFilters) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["orders", user?.id ?? "anonymous", filters],
    queryFn: () => bilateralOrderApi.list(accessToken!, filters),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}

/**
 * 订单簿为只读服务端聚合；价格-时间优先顺序由服务端返回，不含用户身份。
 * I19F：玩家在线时低频轮询刷新（10s），切到后台不轮询；查询失败时不轮询以避免风暴，
 * 由组件根据 isError/isStale 提示「数据可能过期」。
 */
export function useOrderBookQuery(skuId: string | null) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["orders", "book", user?.id ?? "anonymous", skuId],
    queryFn: () => bilateralOrderApi.book(accessToken!, skuId!),
    enabled: Boolean(accessToken && user && skuId),
    retry: false,
    refetchInterval: (query) => (query.state.error ? false : 10_000),
    refetchIntervalInBackground: false
  });
}

/**
 * 玩家视角成交只读查询；按当前用户隔离，只返回自己的成交（脱敏对手）。
 * I19F：轮询语义与订单簿一致——玩家在线时 10s 刷新、后台不轮询、失败不轮询；
 * 组件层据此展示「数据可能过期」而非伪造最新状态。
 */
export function usePlayerTradesQuery(filters: PlayerTradesFilters) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["orders", "trades", user?.id ?? "anonymous", filters],
    queryFn: () => bilateralOrderApi.trades(accessToken!, filters),
    enabled: Boolean(accessToken && user),
    retry: false,
    refetchInterval: (query) => (query.state.error ? false : 10_000),
    refetchIntervalInBackground: false
  });
}

/** 撤单以幂等键 + 订单 ID 提交；同键网络重试返回首次结果。成功只失效服务器真相缓存。 */
export function useCancelOrderMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const intent = useRef<{ key: string; orderId: string } | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: { orderId: string }) => {
      if (!intent.current || intent.current.orderId !== input.orderId) intent.current = { key: createIdempotencyKey(), orderId: input.orderId };
      return bilateralOrderApi.cancel(accessToken!, input.orderId, intent.current.key);
    },
    onSuccess: () => {
      if (user) {
        void queryClient.invalidateQueries({ queryKey: ["orders", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["orders", "book", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["orders", "trades", user.id] });
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

/**
 * I20F 确认履约：以幂等键 + 成交 ID 提交空请求体；买卖任一方均可发起。
 * 同键同成交重放返回首次结果；换成交才生成新键。成功只失效服务器真相缓存，不在浏览器结算余额/库存。
 */
export function useFulfillTradeMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const intent = useRef<{ key: string; tradeId: string } | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: { tradeId: string }) => {
      if (!intent.current || intent.current.tradeId !== input.tradeId) intent.current = { key: createIdempotencyKey(), tradeId: input.tradeId };
      return bilateralOrderApi.fulfillTrade(accessToken!, input.tradeId, intent.current.key);
    },
    onSuccess: () => {
      if (user) {
        void queryClient.invalidateQueries({ queryKey: ["orders", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["orders", "book", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["orders", "trades", user.id] });
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

/**
 * I20F 取消履约：以幂等键 + 成交 ID 提交空请求体；买卖任一方均可发起，到期回收在服务端复用本路径。
 * 同键同成交重放返回首次结果；换成交才生成新键。成功只失效服务器真相缓存，不在浏览器结算。
 */
export function useCancelTradeMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const intent = useRef<{ key: string; tradeId: string } | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: { tradeId: string }) => {
      if (!intent.current || intent.current.tradeId !== input.tradeId) intent.current = { key: createIdempotencyKey(), tradeId: input.tradeId };
      return bilateralOrderApi.cancelTrade(accessToken!, input.tradeId, intent.current.key);
    },
    onSuccess: () => {
      if (user) {
        void queryClient.invalidateQueries({ queryKey: ["orders", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["orders", "book", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["orders", "trades", user.id] });
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
