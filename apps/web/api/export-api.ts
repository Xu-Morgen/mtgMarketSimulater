"use client";

import type { ExportRecordDto } from "@mtg-market/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, downloadAttachment } from "./client";
import { useSession } from "../providers/session-provider";
import { createIdempotencyKey } from "../utils/idempotency";

/**
 * I31F 玩家导出 API。后端 `requireRole("player")` 只校验认证，故 admin 同样可调用，
 * 与库存/市场等玩家页一致。浏览器只下载服务端生成的受控 `attachment` 流，
 * 不读取或拼装文件路径；用户隔离、CSV 公式注入防护与字段稳定由 I31B 服务端保证。
 */
export const exportApi = {
  list: (accessToken: string) => apiRequest<{ items: ExportRecordDto[] }>("/v1/exports", { accessToken }),
  generate: (accessToken: string, formats: Array<"csv" | "json">, idempotencyKey: string) =>
    apiRequest<{ export: ExportRecordDto; skipped: boolean }>("/v1/exports", { method: "POST", accessToken, idempotencyKey, body: { formats } }),
  download: (accessToken: string, id: string, fileName: string) => downloadAttachment(`/v1/exports/${id}/download`, { accessToken }, fileName)
};

export const exportKeys = {
  list: (userId: string) => ["exports", userId] as const
};

export function useExportsQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: exportKeys.list(user?.id ?? "anonymous"),
    queryFn: () => exportApi.list(accessToken!),
    enabled: Boolean(accessToken && user),
    retry: false,
    // 存在生成中的记录时轮询，直到服务端推进为终态；无 running 时不轮询。
    refetchInterval: (query) => (query.state.data?.data.items.some((item) => item.status === "running") ? 2_000 : false)
  });
}

/** 生成导出：组件层生成幂等键，成功后失效导出列表；不在浏览器伪成功或拼装报表。 */
export function useGenerateExportsMutation() {
  const { accessToken } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: (formats: Array<"csv" | "json">) => exportApi.generate(accessToken!, formats, createIdempotencyKey()),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["exports"] }); }
  });
}
