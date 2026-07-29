import { describe, expect, it } from "vitest";
import { naturalDateAt, nextNaturalDate, startOfNaturalDate } from "./natural-day.js";

describe("I23B 服务器自然日", () => {
  it("按配置时区而非 UTC 或浏览器时钟派生日期", () => {
    const now = new Date("2026-01-01T00:30:00.000Z");
    expect(naturalDateAt(now, "America/Los_Angeles")).toBe("2025-12-31");
    expect(naturalDateAt(now, "Asia/Shanghai")).toBe("2026-01-01");
  });

  it("DST 边界的下一资格时刻仍是当地次日零点", () => {
    expect(startOfNaturalDate("2026-03-09", "America/New_York")).toBe("2026-03-09T04:00:00.000Z");
    expect(startOfNaturalDate(nextNaturalDate("2026-03-08"), "America/New_York")).toBe("2026-03-09T04:00:00.000Z");
  });
});
