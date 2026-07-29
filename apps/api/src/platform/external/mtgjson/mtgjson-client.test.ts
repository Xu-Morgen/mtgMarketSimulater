import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MtgjsonChecksumMismatchError, MtgjsonClient } from "./mtgjson-client.js";

/**
 * MTGJSON 流式适配器回归测试：验证流式下载（边写临时文件边算 SHA-256）与流式解析
 *（createReadStream → maybeGunzip → stream-json）产出与原全量解析等价，且支持 gzip 与未压缩两种载荷。
 * 复用 price-sync-service.test 的 fake fetcher 模式：返回 `new Response(bytes)` 与 `.sha256` hex。
 */
const uuid = "30000000-0000-4000-8000-000000000001";
const scryfallId = "20000000-0000-4000-8000-000000000001";

function todayPrices() {
  return { data: { [uuid]: { paper: { cardmarket: { currency: "EUR", retail: { normal: { "2026-07-24": 1.01, "2026-07-25": 1.23 }, foil: { "2026-07-25": 4.56 }, etched: { "2026-07-25": 7.89 } } } } } }, meta: { date: "2026-07-25" } };
}
function allPrices() {
  // 同一 UUID+工艺多个自然日正值（回填场景；这是原 0x1fffffe8 报错的入口）。
  return { data: { [uuid]: { paper: { cardmarket: { currency: "EUR", retail: { normal: { "2026-07-23": 1.0, "2026-07-24": 1.1, "2026-07-25": 1.23 }, foil: { "2026-07-25": 4.56 } } } } } }, meta: { date: "2026-07-25" } };
}
function printings() {
  return { data: { TST: { cards: [{ uuid, finishes: ["nonfoil", "foil", "etched"], identifiers: { scryfallId } }] }, TST2: { cards: [{ uuid: "other", finishes: ["nonfoil"], identifiers: { scryfallId: "absent" } }] } }, meta: { version: "5.3.0" } };
}

function fakeFetcher(routes: Record<string, Buffer>): typeof fetch {
  return async (input) => {
    const target = String(input);
    const isChecksum = target.endsWith(".sha256");
    const key = isChecksum ? target.replace(/\.sha256$/, "") : target;
    const bytes = Object.entries(routes).find(([prefix]) => key.includes(prefix))?.[1];
    if (!bytes) return new Response("not found", { status: 404 });
    if (isChecksum) return new Response(createHash("sha256").update(bytes).digest("hex"));
    return new Response(bytes);
  };
}

function sha256Of(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

describe("MTGJSON 流式适配器", () => {
  for (const [label, wrap] of [["未压缩", (b: Buffer) => b], ["gzip", (b: Buffer) => gzipSync(b)]] as const) {
    describe(`${label} 载荷`, () => {
      it("download 流式解析 AllPricesToday + AllPrintings，校验通过并保留 UUID/工艺映射", async () => {
        const priceBytes = wrap(Buffer.from(JSON.stringify(todayPrices())));
        const mappingBytes = wrap(Buffer.from(JSON.stringify(printings())));
        const client = new MtgjsonClient("https://fixture.test/prices", "https://fixture.test/printings", "test", fakeFetcher({ "/prices": priceBytes, "/printings": mappingBytes }));
        const source = await client.download();
        expect(source.checksumVerification).toBe("verified");
        expect(source.pricesChecksumSha256).toBe(sha256Of(priceBytes));
        expect(source.version).toBe("2026-07-25");
        // 价格：按工艺保留最新日正值，key 为 `uuid:工艺`。
        expect(Object.fromEntries(source.prices)).toEqual({
          [`${uuid}:normal`]: { priceType: "normal", currency: "EUR", amount: 1.23 },
          [`${uuid}:foil`]: { priceType: "foil", currency: "EUR", amount: 4.56 },
          [`${uuid}:etched`]: { priceType: "etched", currency: "EUR", amount: 7.89 }
        });
        // 映射：流式逐卡提取，含 TST 与 TST2 两个系列。
        expect(source.mappings).toContainEqual({ scryfallId, finish: "nonfoil", mtgjsonUuid: uuid });
        expect(source.mappings).toContainEqual({ scryfallId, finish: "foil", mtgjsonUuid: uuid });
        expect(source.mappings.some((m) => m.mtgjsonUuid === "other")).toBe(true);
      });

      it("downloadAllPrices 流式解析，保留每个 UUID+工艺的全部自然日 EUR 正值", async () => {
        const bytes = wrap(Buffer.from(JSON.stringify(allPrices())));
        const client = new MtgjsonClient("https://fixture.test/prices", "https://fixture.test/printings", "test", fakeFetcher({ "/allprices": bytes }), "https://fixture.test/allprices");
        const source = await client.downloadAllPrices();
        expect(source.checksumVerification).toBe("verified");
        expect(source.version).toBe("2026-07-25");
        expect(source.prices.get(`${uuid}:normal`)?.map((p) => p.date)).toEqual(["2026-07-23", "2026-07-24", "2026-07-25"]);
        expect(source.prices.get(`${uuid}:normal`)?.every((p) => p.currency === "EUR")).toBe(true);
        expect(source.prices.get(`${uuid}:foil`)?.length).toBe(1);
      });
    });
  }

  it("provider checksum 不匹配时抛 MtgjsonChecksumMismatchError；allowChecksumMismatch 时标 bypassed", async () => {
    const priceBytes = Buffer.from(JSON.stringify(todayPrices()));
    const mappingBytes = Buffer.from(JSON.stringify(printings()));
    const wrongSha = "0".repeat(64);
    const client = new MtgjsonClient("https://fixture.test/prices", "https://fixture.test/printings", "test", async (input) => {
      const target = String(input);
      if (target.endsWith(".sha256")) return new Response(wrongSha);
      return new Response(target.includes("/prices") ? priceBytes : mappingBytes);
    });
    await expect(client.download()).rejects.toBeInstanceOf(MtgjsonChecksumMismatchError);
    const source = await client.download({ allowChecksumMismatch: true });
    expect(source.checksumVerification).toBe("bypassed");
  });

  it("缺失 cards 时抛错；非 EUR/零价被跳过", async () => {
    const noCards = { data: { TST: {} }, meta: {} };
    const priceBytes = Buffer.from(JSON.stringify({ data: { [uuid]: { paper: { cardmarket: { currency: "USD", retail: { normal: { "2026-07-25": 1 } } } } } }, meta: { date: "2026-07-25" } }));
    const mappingBytes = Buffer.from(JSON.stringify(noCards));
    const client = new MtgjsonClient("https://fixture.test/prices", "https://fixture.test/printings", "test", fakeFetcher({ "/prices": priceBytes, "/printings": mappingBytes }));
    await expect(client.download()).rejects.toThrow("cards");
    // 重新构造一个正常 printings 的客户端验证非 EUR 被跳过。
    const okMapping = Buffer.from(JSON.stringify(printings()));
    const ok = new MtgjsonClient("https://fixture.test/prices", "https://fixture.test/printings", "test", fakeFetcher({ "/prices": priceBytes, "/printings": okMapping }));
    const source = await ok.download();
    expect(source.prices.size).toBe(0); // USD 被跳过
  });
});
