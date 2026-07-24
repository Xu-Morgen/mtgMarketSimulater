"use client";

import type { CardFinish, InventoryHoldingDto, Page } from "@mtg-market/contracts";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";

export type InventoryFilters = {
  query?: string | undefined;
  setCode?: string | undefined;
  finish?: CardFinish | undefined;
  locked?: "any" | "locked" | "available" | undefined;
  sort?: "updatedAt" | "name" | "quantity" | "availableQuantity" | undefined;
  direction?: "asc" | "desc" | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

function queryString(filters: InventoryFilters): string {
  const parameters = new URLSearchParams({ limit: String(filters.limit ?? 20) });
  for (const [key, value] of Object.entries(filters)) if (value) parameters.set(key, String(value));
  return parameters.toString();
}

/** 库存页面只读取服务端持仓快照，不在浏览器计算市值、成本或可用量。 */
export const inventoryApi = {
  list: (accessToken: string, filters: InventoryFilters) => apiRequest<Page<InventoryHoldingDto>>(`/v1/inventory?${queryString(filters)}`, { accessToken })
};

export function useInventoryQuery(filters: InventoryFilters) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["inventory", user?.id ?? "anonymous", filters],
    queryFn: () => inventoryApi.list(accessToken!, filters),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}
