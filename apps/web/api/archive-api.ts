"use client";

import type { GameArchiveSummaryDto, LedgerEntryDto, Page } from "@mtg-market/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";
import { createIdempotencyKey } from "../utils/idempotency";

/** 服务器真相必须按登录用户隔离，不能让前一会话的缓存进入下一账户。 */
export const archiveQueryKey = (userId: string) => ["archive", userId] as const;
export const ledgerQueryKey = (userId: string, cursor: string | null) => ["ledger", userId, cursor] as const;

export const archiveApi = {
  get: (accessToken: string) => apiRequest<{ archive: GameArchiveSummaryDto }>("/v1/archive", { accessToken }),
  create: (accessToken: string, idempotencyKey: string) => apiRequest<{ archive: GameArchiveSummaryDto }>("/v1/archive", { method: "POST", body: {}, accessToken, idempotencyKey }),
  ledger: (accessToken: string, cursor: string | null) => {
    const query = new URLSearchParams({ limit: "20" });
    if (cursor) query.set("cursor", cursor);
    return apiRequest<Page<LedgerEntryDto>>(`/v1/ledger?${query.toString()}`, { accessToken });
  }
};

export function useArchiveQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: archiveQueryKey(user?.id ?? "anonymous"),
    queryFn: () => archiveApi.get(accessToken!),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}

export function useLedgerQuery(cursor: string | null, enabled: boolean) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ledgerQueryKey(user?.id ?? "anonymous", cursor),
    queryFn: () => archiveApi.ledger(accessToken!, cursor),
    enabled: enabled && Boolean(accessToken && user)
  });
}

/** 同一次用户意图重试复用 key，成功后才允许下一次独立意图生成新 key。 */
export function useCreateArchiveMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const idempotencyKey = useRef<string | null>(null);
  return useMutation({
    mutationFn: async () => {
      idempotencyKey.current ??= createIdempotencyKey();
      return archiveApi.create(accessToken!, idempotencyKey.current);
    },
    onSuccess: ({ data }) => {
      queryClient.setQueryData(archiveQueryKey(user!.id), { data });
      void queryClient.invalidateQueries({ queryKey: ["ledger", user!.id] });
      idempotencyKey.current = null;
    }
  });
}
