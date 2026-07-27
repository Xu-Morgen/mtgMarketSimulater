import { PackDetailPage } from "../../../../features/packs/packs-page";

export default async function PackDetailRoute({
  params
}: Readonly<{ params: Promise<{ packId: string }> }>) {
  const { packId } = await params;
  return <PackDetailPage packId={packId} />;
}
