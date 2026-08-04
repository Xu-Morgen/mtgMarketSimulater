"use client";

import type { BulkPackOpeningDto, PackDto, PackOpeningDto, PackPurchasePreviewDto, Page } from "@mtg-market/contracts";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";
import { createIdempotencyKey } from "../utils/idempotency";

/** 补充包只读取服务端已经发布的配置；浏览器不持有候选池、种子或抽取规则。 */
export const packsApi = {
  list: (accessToken: string) => apiRequest<{ items: PackDto[] }>("/v1/packs", { accessToken }),
  detail: (accessToken: string, packId: string) =>
    apiRequest<{ pack: PackDto }>(`/v1/packs/${packId}`, { accessToken }),
  purchasePreview: (accessToken: string, packId: string) =>
    apiRequest<{ preview: PackPurchasePreviewDto }>(`/v1/store/packs/${packId}/purchase-preview`, {
      accessToken
    }),
  open: (accessToken: string, packId: string, ruleVersion: string, idempotencyKey: string) =>
    apiRequest<{ opening: PackOpeningDto }>(`/v1/packs/${packId}/open`, {
      method: "POST",
      body: { ruleVersion },
      accessToken,
      idempotencyKey
    }),
  /** I33F（I33B C7）：批量开包 10/50/100，同一购买意图复用幂等键。 */
  openBulk: (accessToken: string, packId: string, ruleVersion: string, count: number, idempotencyKey: string) =>
    apiRequest<{ bulk: BulkPackOpeningDto }>(`/v1/packs/${packId}/bulk`, {
      method: "POST",
      body: { ruleVersion, count },
      accessToken,
      idempotencyKey
    }),
  history: (accessToken: string, cursor: string | null) => {
    const query = new URLSearchParams({ limit: "20" });
    if (cursor) query.set("cursor", cursor);
    return apiRequest<Page<PackOpeningDto>>(`/v1/pack-openings?${query.toString()}`, {
      accessToken
    });
  }
};

export const packHistoryQueryKey = (userId: string, cursor: string | null) =>
  ["pack-openings", userId, cursor] as const;

export function usePacksQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["packs", user?.id ?? "anonymous"],
    queryFn: () => packsApi.list(accessToken!),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}

export function usePackDetailQuery(packId: string) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["packs", "detail", user?.id ?? "anonymous", packId],
    queryFn: () => packsApi.detail(accessToken!, packId),
    enabled: Boolean(accessToken && user && packId),
    retry: false
  });
}

/** 预览决定是否可确认；浏览器只回传服务端给出的 ruleVersion。 */
export function usePackPurchasePreviewQuery(packId: string, enabled: boolean) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["packs", "purchase-preview", user?.id ?? "anonymous", packId],
    queryFn: () => packsApi.purchasePreview(accessToken!, packId),
    enabled: enabled && Boolean(accessToken && user && packId),
    // 每次重新打开确认框都是新的预览意图，不能在 30 秒默认缓存期内沿用旧余额/版本。
    refetchOnMount: "always",
    retry: false
  });
}

export function usePackOpeningsQuery(cursor: string | null) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: packHistoryQueryKey(user?.id ?? "anonymous", cursor),
    queryFn: () => packsApi.history(accessToken!, cursor),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}

type OpenIntent = { key: string; packId: string; ruleVersion: string };

/**
 * 同一购买意图（包括网络重试）固定使用同一幂等键；重新预览或切换补充包才开始新意图。
 * 成功后只失效服务器真相查询，开包结果仍以 mutation 返回值交给页面展示。
 */
export function useOpenPackMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const intent = useRef<OpenIntent | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: { packId: string; ruleVersion: string }) => {
      if (
        !intent.current ||
        intent.current.packId !== input.packId ||
        intent.current.ruleVersion !== input.ruleVersion
      ) {
        intent.current = { key: createIdempotencyKey(), ...input };
      }
      return packsApi.open(accessToken!, input.packId, input.ruleVersion, intent.current.key);
    },
    onSuccess: () => {
      if (user) {
        void queryClient.invalidateQueries({ queryKey: ["archive", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["ledger", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["inventory", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["pack-openings", user.id] });
        // I33F：开包会改变收藏图鉴与系列收集率里程碑进度。
        void queryClient.invalidateQueries({ queryKey: ["collection", "album", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["achievements", user.id] });
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

/** 服务端开包后需要失效的玩家真相缓存；单包与批量开包共用。 */
export function invalidateOpeningTruth(queryClient: QueryClient, userId: string): void {
  void queryClient.invalidateQueries({ queryKey: ["archive", userId] });
  void queryClient.invalidateQueries({ queryKey: ["ledger", userId] });
  void queryClient.invalidateQueries({ queryKey: ["inventory", userId] });
  void queryClient.invalidateQueries({ queryKey: ["pack-openings", userId] });
  void queryClient.invalidateQueries({ queryKey: ["collection", "album", userId] });
  void queryClient.invalidateQueries({ queryKey: ["achievements", userId] });
}

type BulkIntent = { key: string; packId: string; ruleVersion: string; count: number };

/**
 * I33F（I33B C7）：批量开包。同一 `(packId, ruleVersion, count)` 网络重试复用同一幂等键，
 * 重新预览或任一参数变化才开始新意图；成功后只失效服务器真相查询。
 */
export function useOpenBulkPackMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const intent = useRef<BulkIntent | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: { packId: string; ruleVersion: string; count: number }) => {
      if (
        !intent.current ||
        intent.current.packId !== input.packId ||
        intent.current.ruleVersion !== input.ruleVersion ||
        intent.current.count !== input.count
      ) {
        intent.current = { key: createIdempotencyKey(), ...input };
      }
      return packsApi.openBulk(accessToken!, input.packId, input.ruleVersion, input.count, intent.current.key);
    },
    onSuccess: () => {
      if (user) invalidateOpeningTruth(queryClient, user.id);
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
