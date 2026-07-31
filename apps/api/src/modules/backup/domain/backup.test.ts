import { describe, expect, it } from "vitest";
import { retentionToKeep } from "./backup.js";

describe("I31B 备份保留策略 retentionToKeep", () => {
  const base = (id: string, status: "succeeded" | "failed" | "running", createdAt: string) => ({ id, status, createdAt });

  it("按 createdAt 降序保留前 N 份 succeeded，返回超出数量的旧记录", () => {
    const records = [
      base("b1", "succeeded", "2026-07-25T00:00:00.000Z"),
      base("b2", "succeeded", "2026-07-28T00:00:00.000Z"),
      base("b3", "succeeded", "2026-07-31T00:00:00.000Z")
    ];
    // retention=2：最新两份 b3、b2 保留，最旧 b1 被淘汰。
    expect(retentionToKeep(records, 2)).toEqual([{ id: "b1", createdAt: "2026-07-25T00:00:00.000Z" }]);
  });

  it("succeeded 数量未超过保留数时返回空数组", () => {
    const records = [base("b1", "succeeded", "2026-07-25T00:00:00.000Z")];
    expect(retentionToKeep(records, 7)).toEqual([]);
  });

  it("failed/running 记录不参与保留计数", () => {
    const records = [
      base("f1", "failed", "2026-07-20T00:00:00.000Z"),
      base("r1", "running", "2026-07-19T00:00:00.000Z"),
      base("b1", "succeeded", "2026-07-25T00:00:00.000Z"),
      base("b2", "succeeded", "2026-07-28T00:00:00.000Z"),
      base("b3", "succeeded", "2026-07-31T00:00:00.000Z")
    ];
    // 只有 3 份 succeeded；retention=2 淘汰 1 份最旧 succeeded（b1），failed/running 不计入。
    expect(retentionToKeep(records, 2)).toEqual([{ id: "b1", createdAt: "2026-07-25T00:00:00.000Z" }]);
  });

  it("永不返回最新成功记录（防御性，即使 retention 偏小）", () => {
    const records = [
      base("b1", "succeeded", "2026-07-25T00:00:00.000Z"),
      base("b2", "succeeded", "2026-07-28T00:00:00.000Z"),
      base("b3", "succeeded", "2026-07-31T00:00:00.000Z")
    ];
    // 最新是 b3；任何淘汰结果都不应包含 b3。
    const pruned = retentionToKeep(records, 1);
    expect(pruned.map((p) => p.id).includes("b3")).toBe(false);
    expect(pruned).toEqual([{ id: "b2", createdAt: "2026-07-28T00:00:00.000Z" }, { id: "b1", createdAt: "2026-07-25T00:00:00.000Z" }]);
  });

  it("空记录返回空数组", () => {
    expect(retentionToKeep([], 7)).toEqual([]);
  });

  it("retention 非正整数抛错", () => {
    expect(() => retentionToKeep([], 0)).toThrow(RangeError);
    expect(() => retentionToKeep([], -1)).toThrow(RangeError);
  });
});
