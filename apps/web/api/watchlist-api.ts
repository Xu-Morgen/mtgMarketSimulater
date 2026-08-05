"use client";

import type { WatchlistAlertsDto, WatchlistItemDto, WatchlistLimitsDto } from "@mtg-market/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";
import { createIdempotencyKey } from "../utils/idempotency";

/**
 * I34F（I34B E12）：目标价提醒。浏览器只提交用户意图（SKU、目标价类型/方向/数值、启停），
 * 目标价与方向只由服务端保存；命中判定由服务端 `watchlist.check` 任务按最新报价快照执行，
 * 浏览器不重判命中、不推算触发价。
 */
export type WatchlistInput = {
  skuId: string;
  targetType: "game_price" | "reference_price";
  direction: "at_or_below" | "at_or_above";
  targetAmount: number;
  enabled: boolean;
};

export const watchlistApi = {
  list: (accessToken: string) => apiRequest<{ items: WatchlistItemDto[]; limits: WatchlistLimitsDto }>("/v1/watchlist", { accessToken }),
  upsert: (accessToken: string, input: WatchlistInput, idempotencyKey: string) =>
    apiRequest<WatchlistItemDto>("/v1/watchlist", {
      method: "POST",
      accessToken,
      idempotencyKey,
      body: {
        skuId: input.skuId,
        targetType: input.targetType,
        direction: input.direction,
        targetAmount: input.targetAmount,
        enabled: input.enabled
      }
    }),
  remove: (accessToken: string, skuId: string, idempotencyKey: string) =>
    apiRequest<{ removed: boolean }>(`/v1/watchlist/${skuId}`, { method: "DELETE", accessToken, idempotencyKey }),
  alerts: (accessToken: string) => apiRequest<WatchlistAlertsDto>("/v1/watchlist/alerts", { accessToken }),
  markRead: (accessToken: string, alertId: string, idempotencyKey: string) =>
    apiRequest<{ alertId: string; read: boolean }>(`/v1/watchlist/alerts/${alertId}/read`, { method: "POST", accessToken, idempotencyKey })
};

/** 我的目标价提醒列表（只读）；条目/上限均来自服务端，不包含卡名等目录投影。 */
export function useWatchlistQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["watchlist", user?.id ?? "anonymous"],
    queryFn: () => watchlistApi.list(accessToken!),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}

/** 已触达提醒列表（只读）；未读数由服务端统计，浏览器不自行计数。 */
export function useWatchlistAlertsQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["watchlist", "alerts", user?.id ?? "anonymous"],
    queryFn: () => watchlistApi.alerts(accessToken!),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}

type UpsertIntent = { key: string } & WatchlistInput;

/**
 * 保存/更新目标价提醒。同一 `(skuId, targetType, direction, targetAmount, enabled)` 的网络
 * 重试复用幂等键；任一字段变化才生成新键。成功只失效 watchlist 服务器真相缓存。
 */
export function useWatchlistUpsertMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const intent = useRef<UpsertIntent | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: WatchlistInput) => {
      if (
        !intent.current ||
        intent.current.skuId !== input.skuId ||
        intent.current.targetType !== input.targetType ||
        intent.current.direction !== input.direction ||
        intent.current.targetAmount !== input.targetAmount ||
        intent.current.enabled !== input.enabled
      ) intent.current = { key: createIdempotencyKey(), ...input };
      return watchlistApi.upsert(accessToken!, input, intent.current.key);
    },
    onSuccess: () => {
      if (user) void queryClient.invalidateQueries({ queryKey: ["watchlist", user.id] });
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

/** 删除目标价提醒；同 SKU 的重复点击复用幂等键。成功只失效 watchlist 缓存。 */
export function useWatchlistRemoveMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const intent = useRef<{ key: string; skuId: string } | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: { skuId: string }) => {
      if (!intent.current || intent.current.skuId !== input.skuId) intent.current = { key: createIdempotencyKey(), skuId: input.skuId };
      return watchlistApi.remove(accessToken!, input.skuId, intent.current.key);
    },
    onSuccess: () => {
      if (user) void queryClient.invalidateQueries({ queryKey: ["watchlist", user.id] });
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

/** 标记提醒已读；同一提醒的重复提交复用幂等键。成功只刷新提醒列表。 */
export function useMarkAlertReadMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const intent = useRef<{ key: string; alertId: string } | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: { alertId: string }) => {
      if (!intent.current || intent.current.alertId !== input.alertId) intent.current = { key: createIdempotencyKey(), alertId: input.alertId };
      return watchlistApi.markRead(accessToken!, input.alertId, intent.current.key);
    },
    onSuccess: () => {
      if (user) void queryClient.invalidateQueries({ queryKey: ["watchlist", "alerts", user.id] });
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
