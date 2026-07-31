import { describe, expect, it } from "vitest";
import {
  campaignRequestFingerprint,
  campaignStatusTransition,
  detectCampaignConflicts,
  validateCampaignDefinition
} from "./campaign.js";
import {
  compensationRequestFingerprint,
  validateCompensationInput
} from "./compensation.js";
import {
  importDraftRequestFingerprint,
  resolveDraftMapping,
  validateSetlistEntries
} from "./import-draft.js";

describe("campaign domain", () => {
  const valid = {
    campaignType: "market_factor" as const,
    scopeType: "global" as const,
    scopeId: null,
    factorBps: 8000,
    startsAt: "2026-08-01T00:00:00.000Z",
    endsAt: "2026-08-31T00:00:00.000Z",
    displayText: "夏季供需活动",
    name: "夏季活动",
    code: "summer-2026",
    description: null,
    reason: "运营"
  };

  it("accepts a valid global campaign definition", () => {
    expect(validateCampaignDefinition(valid)).toEqual([]);
  });

  it("rejects scope_id for global and requires it for set/sku", () => {
    expect(validateCampaignDefinition({ ...valid, scopeId: "ONE" })).toContain("scope_id_forbidden");
    expect(validateCampaignDefinition({ ...valid, scopeType: "set", scopeId: null })).toContain("scope_id_required");
  });

  it("rejects factor_bps out of range", () => {
    expect(validateCampaignDefinition({ ...valid, factorBps: 4000 })).toContain("factor_out_of_range");
    expect(validateCampaignDefinition({ ...valid, factorBps: 30000 })).toContain("factor_out_of_range");
  });

  it("rejects ends_at before or equal to starts_at", () => {
    expect(validateCampaignDefinition({ ...valid, endsAt: "2026-07-31T00:00:00.000Z" })).toContain("ends_before_start");
  });

  it("detects overlapping conflicts on same scope+scopeId", () => {
    const active = [{ campaignId: "c1", code: "old", scopeType: "set" as const, scopeId: "ONE", startsAt: "2026-08-10T00:00:00.000Z", endsAt: "2026-09-10T00:00:00.000Z" }];
    expect(detectCampaignConflicts({ scopeType: "set", scopeId: "ONE", startsAt: "2026-08-15T00:00:00.000Z", endsAt: "2026-08-20T00:00:00.000Z" }, active)).toHaveLength(1);
    expect(detectCampaignConflicts({ scopeType: "set", scopeId: "TWO", startsAt: "2026-08-15T00:00:00.000Z", endsAt: "2026-08-20T00:00:00.000Z" }, active)).toHaveLength(0);
  });

  it("enforces the status transition machine", () => {
    expect(campaignStatusTransition("draft", "previewing")).toBe(true);
    expect(campaignStatusTransition("previewing", "published")).toBe(true);
    expect(campaignStatusTransition("published", "paused")).toBe(true);
    expect(campaignStatusTransition("paused", "ended")).toBe(true);
    expect(campaignStatusTransition("ended", "published")).toBe(false);
    expect(campaignStatusTransition("draft", "ended")).toBe(false);
  });

  it("produces a stable request fingerprint", () => {
    expect(campaignRequestFingerprint({ a: 1, b: 2 })).toBe(campaignRequestFingerprint({ b: 2, a: 1 }));
  });
});

describe("compensation domain", () => {
  it("rejects zero amount and missing reason", () => {
    expect(validateCompensationInput({ kind: "balance", amount: 0, reason: "理由", direction: "credit" })).toContain("amount_zero");
    expect(validateCompensationInput({ kind: "balance", amount: 100, reason: "", direction: "credit" })).toContain("reason_required");
  });

  it("rejects direction mismatch", () => {
    expect(validateCompensationInput({ kind: "balance", amount: -100, reason: "理由", direction: "credit" })).toContain("direction_mismatch");
    expect(validateCompensationInput({ kind: "balance", amount: 100, reason: "理由", direction: "debit" })).toContain("direction_mismatch");
  });

  it("accepts valid credit/debit", () => {
    expect(validateCompensationInput({ kind: "balance", amount: 100, reason: "运营补偿", direction: "credit" })).toEqual([]);
    expect(validateCompensationInput({ kind: "inventory", amount: -3, reason: "库存修正", direction: "debit" })).toEqual([]);
  });

  it("produces a stable fingerprint", () => {
    expect(compensationRequestFingerprint({ userId: "u1", amount: 5 })).toBe(compensationRequestFingerprint({ amount: 5, userId: "u1" }));
  });
});

describe("import-draft domain", () => {
  it("filters out invalid setlist entries", () => {
    const entries = validateSetlistEntries([{ code: "ONE", name: "Set One" }, { code: "", name: "Bad" }, { name: "NoCode" }, "bad"] as unknown[]);
    expect(entries).toEqual([{ code: "ONE", name: "Set One", releaseDate: null }]);
  });

  it("maps setlist against local sets", () => {
    const setlist = [{ code: "ONE", name: "Set One", releaseDate: null }, { code: "TWO", name: "Set Two", releaseDate: null }, { code: "THR", name: "Set Three", releaseDate: null }];
    const local = [{ code: "ONE", name: "Set One" }, { code: "TWO", name: "Different Name" }];
    const result = resolveDraftMapping(setlist, local);
    expect(result.importableCount).toBe(1);
    expect(result.missingCount).toBe(1);
    expect(result.conflictCount).toBe(1);
    expect(result.mappingStatus).toBe("conflict");
  });

  it("produces a stable fingerprint", () => {
    expect(importDraftRequestFingerprint({ x: 1 })).toBe(importDraftRequestFingerprint({ x: 1 }));
  });
});
