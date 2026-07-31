"use client";

import type { PlayerDashboardDto } from "@mtg-market/contracts";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";

/** 玩家首页始终读取同一份服务端聚合快照，不在浏览器相加资产或推导待办。 */
export const dashboardQueryKey = (userId: string) => ["dashboard", userId] as const;

export const dashboardApi = {
  get: (accessToken: string) => apiRequest<{ overview: PlayerDashboardDto }>("/v1/dashboard", { accessToken })
};

export function useDashboardQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: dashboardQueryKey(user?.id ?? "anonymous"),
    queryFn: () => dashboardApi.get(accessToken!),
    enabled: Boolean(accessToken && user),
    retry: false,
    refetchOnMount: "always"
  });
}
