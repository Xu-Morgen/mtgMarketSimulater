"use client";

import type {
  AdminAuditLogDetailDto,
  AdminAuditLogDto,
  AdminAuditLogQuery,
  AdminCampaignDto,
  AdminCampaignPreviewDto,
  AdminCompensationResultDto,
  AdminDashboardDto,
  AdminExceptionTradeDto,
  AdminMarketParametersDto,
  AdminPackRulePreviewDto,
  AdminUserDetailDto,
  AdminUserListItemDto,
  CampaignScopeType,
  JobDto,
  MtgjsonImportDraftDto,
  MtgjsonImportDraftSummaryDto,
  Page
} from "@mtg-market/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";
import { createIdempotencyKey } from "../utils/idempotency";

/**
 * I30F 管理后台只调用本地 Fastify 管理 API。所有写操作在组件层生成幂等键；
 * 服务端继续以 admin 角色、Idempotency-Key、实体版本与不可变审计为权威。
 * 浏览器不展示密钥、Provider 原文或未实现的活动包/每日任务配置。
 */

export type AdminAuditLogFilters = AdminAuditLogQuery;
export type AdminUserFilters = {
  userId?: string | undefined;
  username?: string | undefined;
  role?: "player" | "admin" | undefined;
  status?: "active" | "frozen" | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
};

export type CampaignDraftInput = {
  code: string;
  name: string;
  description: string | null;
  campaignType: "market_factor";
  scopeType: CampaignScopeType;
  scopeId: string | null;
  factorBps: number;
  displayText: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
};

export type MarketParametersInput = {
  eurCentToGameCreditBps: number;
  minimumPrice: number;
  npcBuySpreadBps: number;
  npcSellSpreadBps: number;
  npcFeeBps: number;
  expectedVersion: number;
};

export type PackRuleDefinition = {
  version: string;
  pools: Array<{ id: string; rarity: string; candidates: Array<{ skuId: string; weight: number }> }>;
  slots: Array<{ id: string; draws: number; poolWeights: Array<{ poolId: string; weight: number }> }>;
};

export type SetlistDraftInput = {
  sourceVersion: string;
  sourceChecksumSha256: string | null;
  setlist: Array<{ code: string; name: string; releaseDate?: string | null }>;
};

function auditLogQueryString(filters: AdminAuditLogFilters): string {
  const parameters = new URLSearchParams({ limit: String(filters.limit ?? 20) });
  if (filters.cursor) parameters.set("cursor", filters.cursor);
  if (filters.from) parameters.set("from", filters.from);
  if (filters.to) parameters.set("to", filters.to);
  if (filters.actorId) parameters.set("actorId", filters.actorId);
  if (filters.userId) parameters.set("userId", filters.userId);
  if (filters.entityType) parameters.set("entityType", filters.entityType);
  if (filters.entityId) parameters.set("entityId", filters.entityId);
  if (filters.action) parameters.set("action", filters.action);
  if (filters.requestId) parameters.set("requestId", filters.requestId);
  if (filters.taskType) parameters.set("taskType", filters.taskType);
  return parameters.toString();
}

function userQueryString(filters: AdminUserFilters): string {
  const parameters = new URLSearchParams({ limit: String(filters.limit ?? 20), offset: String(filters.offset ?? 0) });
  if (filters.userId) parameters.set("userId", filters.userId);
  if (filters.username) parameters.set("username", filters.username);
  if (filters.role) parameters.set("role", filters.role);
  if (filters.status) parameters.set("status", filters.status);
  return parameters.toString();
}

export const adminApi = {
  dashboard: (accessToken: string) => apiRequest<AdminDashboardDto>("/v1/admin/dashboard", { accessToken }),
  auditLogs: (accessToken: string, filters: AdminAuditLogFilters) =>
    apiRequest<Page<AdminAuditLogDto>>(`/v1/admin/audit-logs?${auditLogQueryString(filters)}`, { accessToken }),
  auditLog: (accessToken: string, id: string) =>
    apiRequest<{ log: AdminAuditLogDetailDto }>(`/v1/admin/audit-logs/${id}`, { accessToken }),
  exceptionTrades: (accessToken: string, limit = 50) =>
    apiRequest<{ items: AdminExceptionTradeDto[] }>(`/v1/admin/exception-trades?limit=${limit}`, { accessToken }),
  // 活动
  campaigns: (accessToken: string, limit = 20, offset = 0) =>
    apiRequest<{ items: AdminCampaignDto[]; total: number }>(`/v1/admin/campaigns?limit=${limit}&offset=${offset}`, { accessToken }),
  campaign: (accessToken: string, id: string) => apiRequest<{ campaign: AdminCampaignDto }>(`/v1/admin/campaigns/${id}`, { accessToken }),
  createCampaignDraft: (accessToken: string, input: CampaignDraftInput, idempotencyKey: string) =>
    apiRequest<AdminCampaignDto>("/v1/admin/campaigns", { method: "POST", accessToken, idempotencyKey, body: { ...input, campaignType: input.campaignType } }),
  previewCampaign: (accessToken: string, id: string) =>
    apiRequest<AdminCampaignPreviewDto>(`/v1/admin/campaigns/${id}/preview`, { method: "POST", accessToken }),
  publishCampaign: (accessToken: string, id: string, previewVersion: number, idempotencyKey: string) =>
    apiRequest<AdminCampaignDto>(`/v1/admin/campaigns/${id}/publish`, { method: "POST", accessToken, idempotencyKey, body: { previewVersion } }),
  scheduleCampaign: (accessToken: string, id: string, previewVersion: number, idempotencyKey: string) =>
    apiRequest<AdminCampaignDto>(`/v1/admin/campaigns/${id}/schedule`, { method: "POST", accessToken, idempotencyKey, body: { previewVersion } }),
  pauseCampaign: (accessToken: string, id: string, idempotencyKey: string) =>
    apiRequest<AdminCampaignDto>(`/v1/admin/campaigns/${id}/pause`, { method: "POST", accessToken, idempotencyKey }),
  endCampaign: (accessToken: string, id: string, idempotencyKey: string) =>
    apiRequest<AdminCampaignDto>(`/v1/admin/campaigns/${id}/end`, { method: "POST", accessToken, idempotencyKey }),
  // 用户
  users: (accessToken: string, filters: AdminUserFilters) =>
    apiRequest<{ items: AdminUserListItemDto[]; total: number }>(`/v1/admin/users?${userQueryString(filters)}`, { accessToken }),
  userDetail: (accessToken: string, id: string) => apiRequest<{ user: AdminUserDetailDto }>(`/v1/admin/users/${id}`, { accessToken }),
  freezeUser: (accessToken: string, id: string, reason: string, idempotencyKey: string) =>
    apiRequest<{ userId: string; frozen: boolean }>(`/v1/admin/users/${id}/freeze`, { method: "POST", accessToken, idempotencyKey, body: { reason } }),
  unfreezeUser: (accessToken: string, id: string, idempotencyKey: string) =>
    apiRequest<{ userId: string; frozen: boolean }>(`/v1/admin/users/${id}/unfreeze`, { method: "POST", accessToken, idempotencyKey }),
  revokeUserSessions: (accessToken: string, id: string, idempotencyKey: string) =>
    apiRequest<{ userId: string; revokedCount: number }>(`/v1/admin/users/${id}/revoke-sessions`, { method: "POST", accessToken, idempotencyKey }),
  compensateBalance: (accessToken: string, id: string, amount: number, direction: "credit" | "debit", reason: string, idempotencyKey: string) =>
    apiRequest<AdminCompensationResultDto>(`/v1/admin/users/${id}/compensate/balance`, { method: "POST", accessToken, idempotencyKey, body: { amount, direction, reason } }),
  compensateInventory: (accessToken: string, id: string, skuId: string, quantity: number, direction: "credit" | "debit", reason: string, idempotencyKey: string) =>
    apiRequest<AdminCompensationResultDto>(`/v1/admin/users/${id}/compensate/inventory`, { method: "POST", accessToken, idempotencyKey, body: { skuId, quantity, direction, reason } }),
  // 市场参数
  marketParameters: (accessToken: string) => apiRequest<AdminMarketParametersDto>("/v1/admin/market-parameters", { accessToken }),
  updateMarketParameters: (accessToken: string, input: MarketParametersInput, idempotencyKey: string) =>
    apiRequest<AdminMarketParametersDto>("/v1/admin/market-parameters", { method: "POST", accessToken, idempotencyKey, body: input }),
  // 目录系列/SKU 与同步
  series: (accessToken: string) => apiRequest<{ items: Array<{ code: string; name: string; enabledSkuCount: number }> }>("/v1/admin/catalog/series", { accessToken }),
  setSkuTradable: (accessToken: string, skuId: string, tradable: boolean, idempotencyKey: string) =>
    apiRequest<{ skuId: string; tradable: boolean }>(`/v1/admin/catalog/skus/${skuId}/tradable`, { method: "POST", accessToken, idempotencyKey, body: { tradable } }),
  triggerCatalogSync: (accessToken: string, idempotencyKey: string) =>
    apiRequest<{ jobId: string }>("/v1/admin/catalog/sync-trigger", { method: "POST", accessToken, idempotencyKey }),
  triggerPriceSync: (accessToken: string, idempotencyKey: string) =>
    apiRequest<{ jobId: string }>("/v1/admin/prices/sync-trigger", { method: "POST", accessToken, idempotencyKey }),
  jobs: (accessToken: string, status?: string, limit = 50) =>
    apiRequest<{ items: JobDto[] }>(`/v1/admin/jobs?limit=${limit}${status ? `&status=${status}` : ""}`, { accessToken }),
  retryJob: (accessToken: string, jobId: string, idempotencyKey: string) =>
    apiRequest<JobDto>(`/v1/admin/jobs/${jobId}/retry`, { method: "POST", accessToken, idempotencyKey }),
  // MTGJSON 草稿
  createSetlistDraft: (accessToken: string, input: SetlistDraftInput, idempotencyKey: string) =>
    apiRequest<MtgjsonImportDraftDto>("/v1/admin/mtgjson/setlist-draft", { method: "POST", accessToken, idempotencyKey, body: input }),
  importDrafts: (accessToken: string, limit = 20, offset = 0) =>
    apiRequest<{ items: MtgjsonImportDraftDto[]; total: number }>(`/v1/admin/mtgjson/drafts?limit=${limit}&offset=${offset}`, { accessToken }),
  importDraft: (accessToken: string, id: string) => apiRequest<{ draft: MtgjsonImportDraftDto }>(`/v1/admin/mtgjson/drafts/${id}`, { accessToken }),
  previewImportDraft: (accessToken: string, id: string) =>
    apiRequest<MtgjsonImportDraftSummaryDto>(`/v1/admin/mtgjson/drafts/${id}/preview`, { method: "POST", accessToken }),
  discardImportDraft: (accessToken: string, id: string, idempotencyKey: string) =>
    apiRequest<MtgjsonImportDraftDto>(`/v1/admin/mtgjson/drafts/${id}/discard`, { method: "POST", accessToken, idempotencyKey }),
  // 补充包规则
  previewPackRule: (accessToken: string, packId: string, definition: PackRuleDefinition) =>
    apiRequest<AdminPackRulePreviewDto>(`/v1/admin/packs/${packId}/rule-preview`, { method: "POST", accessToken, body: definition }),
  publishPackRule: (accessToken: string, packId: string, definition: PackRuleDefinition, idempotencyKey: string) =>
    apiRequest<{ packId: string; ruleVersion: string }>(`/v1/admin/packs/${packId}/rule-publish`, { method: "POST", accessToken, idempotencyKey, body: definition }),
  disablePack: (accessToken: string, packId: string, reason: string, idempotencyKey: string) =>
    apiRequest<{ packId: string; enabled: boolean }>(`/v1/admin/packs/${packId}/disable`, { method: "POST", accessToken, idempotencyKey, body: { reason } })
};

// ----- 查询 hooks -----

export function useAdminDashboardQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["admin", "dashboard", user?.id ?? "anonymous"],
    queryFn: () => adminApi.dashboard(accessToken!),
    enabled: Boolean(accessToken && user?.role === "admin"),
    retry: false
  });
}

export function useAdminAuditLogsQuery(filters: AdminAuditLogFilters) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["admin", "audit-logs", user?.id ?? "anonymous", filters],
    queryFn: () => adminApi.auditLogs(accessToken!, filters),
    enabled: Boolean(accessToken && user?.role === "admin"),
    retry: false
  });
}

export function useAdminAuditLogQuery(id: string | null) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["admin", "audit-log", user?.id ?? "anonymous", id],
    queryFn: () => adminApi.auditLog(accessToken!, id!),
    enabled: Boolean(accessToken && user?.role === "admin" && id),
    retry: false
  });
}

export function useAdminExceptionTradesQuery(limit = 50) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["admin", "exception-trades", user?.id ?? "anonymous", limit],
    queryFn: () => adminApi.exceptionTrades(accessToken!, limit),
    enabled: Boolean(accessToken && user?.role === "admin"),
    retry: false
  });
}

export function useAdminCampaignsQuery(limit = 20, offset = 0) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["admin", "campaigns", user?.id ?? "anonymous", limit, offset],
    queryFn: () => adminApi.campaigns(accessToken!, limit, offset),
    enabled: Boolean(accessToken && user?.role === "admin"),
    retry: false
  });
}

export function useAdminCampaignQuery(id: string | null) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["admin", "campaign", user?.id ?? "anonymous", id],
    queryFn: () => adminApi.campaign(accessToken!, id!),
    enabled: Boolean(accessToken && user?.role === "admin" && id),
    retry: false
  });
}

export function useAdminUsersQuery(filters: AdminUserFilters) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["admin", "users", user?.id ?? "anonymous", filters],
    queryFn: () => adminApi.users(accessToken!, filters),
    enabled: Boolean(accessToken && user?.role === "admin"),
    retry: false
  });
}

export function useAdminUserDetailQuery(id: string | null) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["admin", "user", user?.id ?? "anonymous", id],
    queryFn: () => adminApi.userDetail(accessToken!, id!),
    enabled: Boolean(accessToken && user?.role === "admin" && id),
    retry: false
  });
}

export function useAdminMarketParametersQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["admin", "market-parameters", user?.id ?? "anonymous"],
    queryFn: () => adminApi.marketParameters(accessToken!),
    enabled: Boolean(accessToken && user?.role === "admin"),
    retry: false
  });
}

export function useAdminSeriesQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["admin", "series", user?.id ?? "anonymous"],
    queryFn: () => adminApi.series(accessToken!),
    enabled: Boolean(accessToken && user?.role === "admin"),
    retry: false
  });
}

export function useAdminImportDraftsQuery(limit = 20, offset = 0) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["admin", "import-drafts", user?.id ?? "anonymous", limit, offset],
    queryFn: () => adminApi.importDrafts(accessToken!, limit, offset),
    enabled: Boolean(accessToken && user?.role === "admin"),
    retry: false
  });
}

export function useAdminJobsQuery(status?: string, limit = 50) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["admin", "jobs", user?.id ?? "anonymous", status ?? "all", limit],
    queryFn: () => adminApi.jobs(accessToken!, status, limit),
    enabled: Boolean(accessToken && user?.role === "admin"),
    retry: false
  });
}

// ----- 写 mutation：组件层生成幂等键，成功后失效相关查询，不在浏览器伪成功 -----

const adminKeys = {
  dashboard: ["admin", "dashboard"] as const,
  audit: ["admin", "audit-logs"] as const,
  campaigns: ["admin", "campaigns"] as const,
  campaign: ["admin", "campaign"] as const,
  users: ["admin", "users"] as const,
  user: ["admin", "user"] as const,
  market: ["admin", "market-parameters"] as const,
  series: ["admin", "series"] as const,
  drafts: ["admin", "import-drafts"] as const,
  exceptions: ["admin", "exception-trades"] as const
};

function invalidateAllAdmin(client: ReturnType<typeof useQueryClient>): void {
  for (const key of Object.values(adminKeys)) void client.invalidateQueries({ queryKey: key });
}

export function useCreateCampaignDraftMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CampaignDraftInput) => adminApi.createCampaignDraft(accessToken!, input, createIdempotencyKey()),
    onSuccess: () => invalidateAllAdmin(client)
  });
}

export function usePreviewCampaignMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminApi.previewCampaign(accessToken!, id),
    onSuccess: () => { void client.invalidateQueries({ queryKey: adminKeys.campaign }); void client.invalidateQueries({ queryKey: adminKeys.campaigns }); }
  });
}

export function usePublishCampaignMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, previewVersion }: { id: string; previewVersion: number }) => adminApi.publishCampaign(accessToken!, id, previewVersion, createIdempotencyKey()),
    onSuccess: () => invalidateAllAdmin(client)
  });
}

export function useScheduleCampaignMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, previewVersion }: { id: string; previewVersion: number }) => adminApi.scheduleCampaign(accessToken!, id, previewVersion, createIdempotencyKey()),
    onSuccess: () => invalidateAllAdmin(client)
  });
}

export function usePauseCampaignMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminApi.pauseCampaign(accessToken!, id, createIdempotencyKey()),
    onSuccess: () => invalidateAllAdmin(client)
  });
}

export function useEndCampaignMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminApi.endCampaign(accessToken!, id, createIdempotencyKey()),
    onSuccess: () => invalidateAllAdmin(client)
  });
}

export function useFreezeUserMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => adminApi.freezeUser(accessToken!, id, reason, createIdempotencyKey()),
    onSuccess: () => invalidateAllAdmin(client)
  });
}

export function useUnfreezeUserMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminApi.unfreezeUser(accessToken!, id, createIdempotencyKey()),
    onSuccess: () => invalidateAllAdmin(client)
  });
}

export function useRevokeUserSessionsMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminApi.revokeUserSessions(accessToken!, id, createIdempotencyKey()),
    onSuccess: () => invalidateAllAdmin(client)
  });
}

export function useCompensateBalanceMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amount, direction, reason }: { id: string; amount: number; direction: "credit" | "debit"; reason: string }) =>
      adminApi.compensateBalance(accessToken!, id, amount, direction, reason, createIdempotencyKey()),
    onSuccess: () => invalidateAllAdmin(client)
  });
}

export function useCompensateInventoryMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, skuId, quantity, direction, reason }: { id: string; skuId: string; quantity: number; direction: "credit" | "debit"; reason: string }) =>
      adminApi.compensateInventory(accessToken!, id, skuId, quantity, direction, reason, createIdempotencyKey()),
    onSuccess: () => invalidateAllAdmin(client)
  });
}

export function useUpdateMarketParametersMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: (input: MarketParametersInput) => adminApi.updateMarketParameters(accessToken!, input, createIdempotencyKey()),
    onSuccess: () => invalidateAllAdmin(client)
  });
}

export function useSetSkuTradableMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: ({ skuId, tradable }: { skuId: string; tradable: boolean }) => adminApi.setSkuTradable(accessToken!, skuId, tradable, createIdempotencyKey()),
    onSuccess: () => { void client.invalidateQueries({ queryKey: adminKeys.series }); }
  });
}

export function useTriggerCatalogSyncAdminMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: () => adminApi.triggerCatalogSync(accessToken!, createIdempotencyKey()),
    onSuccess: () => invalidateAllAdmin(client)
  });
}

export function useTriggerPriceSyncAdminMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: () => adminApi.triggerPriceSync(accessToken!, createIdempotencyKey()),
    onSuccess: () => invalidateAllAdmin(client)
  });
}

export function useRetryJobAdminMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => adminApi.retryJob(accessToken!, jobId, createIdempotencyKey()),
    onSuccess: () => invalidateAllAdmin(client)
  });
}

export function useCreateSetlistDraftMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SetlistDraftInput) => adminApi.createSetlistDraft(accessToken!, input, createIdempotencyKey()),
    onSuccess: () => { void client.invalidateQueries({ queryKey: adminKeys.drafts }); }
  });
}

export function usePreviewImportDraftMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminApi.previewImportDraft(accessToken!, id),
    onSuccess: () => { void client.invalidateQueries({ queryKey: adminKeys.drafts }); }
  });
}

export function useDiscardImportDraftMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminApi.discardImportDraft(accessToken!, id, createIdempotencyKey()),
    onSuccess: () => { void client.invalidateQueries({ queryKey: adminKeys.drafts }); }
  });
}

export function usePreviewPackRuleMutation() {
  const { accessToken } = useSession();
  return useMutation({
    mutationFn: ({ packId, definition }: { packId: string; definition: PackRuleDefinition }) => adminApi.previewPackRule(accessToken!, packId, definition)
  });
}

export function usePublishPackRuleMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: ({ packId, definition }: { packId: string; definition: PackRuleDefinition }) => adminApi.publishPackRule(accessToken!, packId, definition, createIdempotencyKey()),
    onSuccess: () => invalidateAllAdmin(client)
  });
}

export function useDisablePackMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: ({ packId, reason }: { packId: string; reason: string }) => adminApi.disablePack(accessToken!, packId, reason, createIdempotencyKey()),
    onSuccess: () => invalidateAllAdmin(client)
  });
}
