"use client";

import type { CollectionAlbumDto } from "@mtg-market/contracts";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";

export type AlbumFilters = {
  onlyHeld: "any" | "held";
  cursor?: string | undefined;
  limit?: number | undefined;
};

function queryString(filters: AlbumFilters): string {
  const parameters = new URLSearchParams({
    onlyHeld: filters.onlyHeld,
    limit: String(filters.limit ?? 20)
  });
  if (filters.cursor) parameters.set("cursor", filters.cursor);
  return parameters.toString();
}

/** I33F：收藏图鉴只读聚合的唯一浏览器入口；完成度/分组/未收集卡位全部来自服务端，浏览器不统计不估值。 */
export const collectionApi = {
  album: (accessToken: string, filters: AlbumFilters) =>
    apiRequest<CollectionAlbumDto>(`/v1/collection/album?${queryString(filters)}`, { accessToken })
};

export function useCollectionAlbumQuery(filters: AlbumFilters) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["collection", "album", user?.id ?? "anonymous", filters],
    queryFn: () => collectionApi.album(accessToken!, filters),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}
