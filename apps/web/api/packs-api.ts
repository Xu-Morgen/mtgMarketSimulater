"use client";

import type { PackDto } from "@mtg-market/contracts";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";

/** 补充包只读取服务端已经发布的配置；浏览器不持有候选池、种子或抽取规则。 */
export const packsApi = {
  list: (accessToken: string) => apiRequest<{ items: PackDto[] }>("/v1/packs", { accessToken }),
  detail: (accessToken: string, packId: string) =>
    apiRequest<{ pack: PackDto }>(`/v1/packs/${packId}`, { accessToken })
};

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
