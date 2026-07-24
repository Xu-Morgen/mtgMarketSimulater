import type { CatalogSkuDetailDto, CatalogSkuDto, Page } from "@mtg-market/contracts";
import type { CatalogFilters, SqliteCatalogRepository } from "../infrastructure/sqlite-catalog-repository.js";

/** 目录 application 边界：只读查询不泄露同步任务、文件路径或外部 Provider 原始资料。 */
export class CatalogService {
  constructor(private readonly catalog: SqliteCatalogRepository) {}
  list(filters: CatalogFilters): Page<CatalogSkuDto> { return this.catalog.list(filters); }
  detail(skuId: string): CatalogSkuDetailDto | null { return this.catalog.findBySkuId(skuId); }
}
