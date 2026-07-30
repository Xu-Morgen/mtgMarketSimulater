"use client";

import type {
  AchievementDefinitionDto,
  AchievementProgressDto,
  AchievementUnlockDto
} from "@mtg-market/contracts";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "../providers/session-provider";
import { apiRequest } from "./client";

export type AchievementOverviewItem = {
  definition: AchievementDefinitionDto;
  progress: AchievementProgressDto | null;
};

export type AchievementDetail = AchievementOverviewItem & {
  unlock: AchievementUnlockDto | null;
};

/** 成就接口仅查询已结算的服务端进度、解锁与奖励流水，不提供浏览器解锁或发奖能力。 */
export const achievementsApi = {
  overview: (accessToken: string) =>
    apiRequest<{ items: AchievementOverviewItem[] }>("/v1/achievements", { accessToken }),
  detail: (accessToken: string, definitionId: string) =>
    apiRequest<AchievementDetail>(
      `/v1/achievements/detail?${new URLSearchParams({ definitionId }).toString()}`,
      { accessToken }
    )
};

function useAchievementQuery<T>(
  key: readonly string[],
  run: (accessToken: string) => Promise<T>,
  enabled = true
) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["achievements", user?.id ?? "anonymous", ...key],
    queryFn: () => run(accessToken!),
    enabled: enabled && Boolean(accessToken && user),
    retry: false
  });
}

export const useAchievementsQuery = () =>
  useAchievementQuery(["overview"], achievementsApi.overview);

export const useAchievementDetailQuery = (definitionId: string) =>
  useAchievementQuery(
    ["detail", definitionId],
    (accessToken) => achievementsApi.detail(accessToken, definitionId),
    Boolean(definitionId)
  );
