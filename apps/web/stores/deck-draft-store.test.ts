import { beforeEach, describe, expect, it } from "vitest";
import { useDeckDraftStore } from "./deck-draft-store";

describe("deck draft virtual basic restrictions", () => {
  beforeEach(() => useDeckDraftStore.getState().initializeNew());

  it("removes disallowed virtual basics atomically and leaves allowed colors unchanged", () => {
    useDeckDraftStore.getState().setVirtualBasicQuantity("mountain", 40);
    useDeckDraftStore.getState().setVirtualBasicQuantity("island", 20);
    const revisionBeforeRestriction = useDeckDraftStore.getState().revision;

    useDeckDraftStore.getState().restrictVirtualBasics(["mountain"]);

    expect(useDeckDraftStore.getState().cards).toEqual([
      expect.objectContaining({ zone: "virtual_basic", virtualBasic: "mountain", quantity: 40 })
    ]);
    expect(useDeckDraftStore.getState().revision).toBe(revisionBeforeRestriction + 1);

    useDeckDraftStore.getState().restrictVirtualBasics(["mountain"]);
    expect(useDeckDraftStore.getState().revision).toBe(revisionBeforeRestriction + 1);
  });
});
