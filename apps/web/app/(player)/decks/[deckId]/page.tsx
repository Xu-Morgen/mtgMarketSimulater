import { DeckEditorPage } from "../../../../features/decks/decks-page";

export default async function Page({ params }: { params: Promise<{ deckId: string }> }) { const { deckId } = await params; return <DeckEditorPage deckId={deckId} />; }
