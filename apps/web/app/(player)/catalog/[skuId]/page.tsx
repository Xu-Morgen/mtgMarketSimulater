import { CatalogDetailPage } from "../../../../pages/catalog/catalog-page";

export default async function Page({ params }: Readonly<{ params: Promise<{ skuId: string }> }>) {
  const { skuId } = await params;
  return <CatalogDetailPage skuId={skuId} />;
}
