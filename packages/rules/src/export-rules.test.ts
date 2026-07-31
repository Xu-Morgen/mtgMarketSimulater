import { describe, expect, it } from "vitest";
import { csvEscapeCell, csvRow, EXPORT_RULES_VERSION, stableColumnOrder, toCsv } from "./export-rules.js";

describe("I31B 导出纯规则 export-rules", () => {
  it("公开稳定的规则版本", () => {
    expect(EXPORT_RULES_VERSION).toBe("export/v1");
  });

  it("stableColumnOrder 为每个报表返回冻结的列序，且未知报表抛错", () => {
    expect(stableColumnOrder("holdings")).toEqual(["skuId", "cardName", "setCode", "setName", "collectorNumber", "finish", "quantity", "availableQuantity", "orderLockedQuantity", "tournamentLockedQuantity", "averageCostAmount", "marketValueAmount", "marketValueUnavailableReason", "updatedAt"]);
    expect(stableColumnOrder("ledger")).toEqual(["id", "direction", "amount", "balanceAfter", "reason", "correlationId", "occurredAt"]);
    // 两次调用结果完全一致 → 字段稳定可重放。
    expect(stableColumnOrder("p2pTrades")).toEqual(stableColumnOrder("p2pTrades"));
    expect(() => stableColumnOrder("unknown" as never)).toThrow(RangeError);
  });

  describe("csvEscapeCell 公式注入防护", () => {
    it("以 = + - @ 开头的单元格前置单引号", () => {
      expect(csvEscapeCell("=cmd|' /C calc'!A1")).toBe("'=cmd|' /C calc'!A1");
      expect(csvEscapeCell("+1+1")).toBe("'+1+1");
      expect(csvEscapeCell("-2")).toBe("'-2");
      expect(csvEscapeCell("@SUM(A1)")).toBe("'@SUM(A1)");
    });

    it("含逗号/双引号/换行/TAB 的单元格按 RFC 4180 包裹并转义内部引号", () => {
      expect(csvEscapeCell("a,b")).toBe('"a,b"');
      expect(csvEscapeCell('say "hi"')).toBe('"say ""hi"""');
      expect(csvEscapeCell("line1\nline2")).toBe('"line1\nline2"');
      expect(csvEscapeCell("col1\tcol2")).toBe('"col1\tcol2"');
    });

    it("公式符号 + 特殊字符同时存在时先前置单引号再按需整体包裹", () => {
      // =a,b：先前置单引号得到 '=a,b，仍含逗号 → 走包裹分支。
      expect(csvEscapeCell("=a,b")).toBe('"\'=a,b"');
      // =@SUM(B)：前置单引号后不含分隔符 → 不包裹，仅保留单引号。
      expect(csvEscapeCell("=@SUM(B)")).toBe("'=@SUM(B)");
    });

    it("普通数字、空串、中文、emoji 不触发转义", () => {
      expect(csvEscapeCell(123)).toBe("123");
      expect(csvEscapeCell("")).toBe("");
      expect(csvEscapeCell("测试中文")).toBe("测试中文");
      expect(csvEscapeCell("emoji 🃏")).toBe("emoji 🃏");
    });

    it("null/undefined 输出空字符串", () => {
      expect(csvEscapeCell(null)).toBe("");
      expect(csvEscapeCell(undefined)).toBe("");
    });
  });

  it("csvRow 按列序取字段，缺失字段输出空单元格，多余字段忽略", () => {
    const columns = ["a", "b", "c"];
    expect(csvRow({ a: 1, b: "x", c: null }, columns)).toBe("1,x,");
    expect(csvRow({ a: 1, extra: "ignored" }, columns)).toBe("1,,");
    expect(csvRow({ c: "=evil" }, columns)).toBe(",,'=evil");
  });

  it("toCsv 输出表头 + 数据行，空数据只有表头", () => {
    const columns = ["id", "name"];
    expect(toCsv([], columns)).toBe("id,name");
    const csv = toCsv([{ id: "1", name: "=bad" }, { id: "2", name: "ok,name" }], columns);
    expect(csv).toBe('id,name\n1,\'=bad\n2,"ok,name"');
  });

  it("toCsv 与 csvRow 在固定列序下可重放（相同输入相同输出）", () => {
    const rows = [{ id: "u1", amount: 100 }, { id: "u2", amount: 200 }];
    const columns = stableColumnOrder("ledger");
    const first = toCsv(rows as Array<Record<string, unknown>>, columns);
    const second = toCsv(rows as Array<Record<string, unknown>>, columns);
    expect(first).toBe(second);
  });
});
