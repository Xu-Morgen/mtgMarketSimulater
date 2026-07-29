import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { ScryfallBulkClient } from "./scryfall-bulk-client.js";

describe("ScryfallBulkClient", () => {
  it("在元数据和 Bulk 文件请求中标识服务端应用", async () => {
    const headers: Array<HeadersInit | undefined> = [];
    const client = new ScryfallBulkClient(
      "https://api.example.test/bulk",
      "MTG-Market-Simulator/test (contact: test@example.com)",
      async (url, init) => {
        headers.push(init?.headers);
        return String(url).includes("api.example")
          ? new Response(
              JSON.stringify({
                updated_at: "2026-07-24T00:00:00.000Z",
                download_uri: "https://data.example.test/cards.json"
              })
            )
          : new Response("[]");
      }
    );

    await client.download();

    expect(new Headers(headers[0]).get("user-agent")).toBe(
      "MTG-Market-Simulator/test (contact: test@example.com)"
    );
    expect(new Headers(headers[1]).get("user-agent")).toBe(
      "MTG-Market-Simulator/test (contact: test@example.com)"
    );
  });

  it("支持 Scryfall 元数据声明的 gzip Bulk 文件", async () => {
    const client = new ScryfallBulkClient(
      "https://api.example.test/bulk",
      "MTG-Market-Simulator/test",
      async (url) =>
        String(url).includes("api.example")
          ? new Response(
              JSON.stringify({
                updated_at: "2026-07-24T00:00:00.000Z",
                download_uri: "https://data.example.test/cards.json"
              })
            )
          : new Response(gzipSync(Buffer.from("[]")))
    );

    await expect(client.download()).resolves.toMatchObject({ cards: [] });
  });

  it("从新版列表元数据选择 default_cards，并解析 gzip JSONL 文件", async () => {
    const cards = [
      { id: "one", set: "one", set_name: "One", name: "Keep", collector_number: "1" },
      { id: "bro", set: "bro", set_name: "Bro", name: "Discard", collector_number: "1" }
    ];
    const downloadUri = "https://data.example.test/default-cards.jsonl.gz";
    const client = new ScryfallBulkClient(
      "https://api.example.test/bulk-data",
      "MTG-Market-Simulator/test",
      async (url) =>
        String(url).includes("api.example")
          ? new Response(
              JSON.stringify({
                object: "list",
                data: [
                  { type: "oracle_cards", updated_at: "2026-07-29T09:02:24.821+00:00" },
                  {
                    type: "default_cards",
                    updated_at: "2026-07-29T09:08:26.918+00:00",
                    jsonl_download_uri: downloadUri
                  }
                ]
              })
            )
          : new Response(
              gzipSync(Buffer.from(`${cards.map((card) => JSON.stringify(card)).join("\n")}\n`))
            )
    );

    await expect(client.download(["ONE"])).resolves.toMatchObject({
      version: "2026-07-29T09:08:26.918+00:00",
      downloadUri,
      cards: [expect.objectContaining({ id: "one" })]
    });
  });

  it("在列表元数据缺少 default_cards 时提供稳定错误", async () => {
    const client = new ScryfallBulkClient(
      "https://api.example.test/bulk-data",
      "MTG-Market-Simulator/test",
      async () => new Response(JSON.stringify({ object: "list", data: [{ type: "oracle_cards" }] }))
    );

    await expect(client.download()).rejects.toThrow("未找到 default_cards");
  });

  it("逐个对象解析并只保留启用系列，不转换整份 Bulk 文本", async () => {
    const cards = [
      { id: "one", set: "one", set_name: "One", name: "Keep", collector_number: "1" },
      { id: "bro", set: "bro", set_name: "Bro", name: "Discard", collector_number: "1" }
    ];
    const client = new ScryfallBulkClient(
      "https://api.example.test/bulk",
      "MTG-Market-Simulator/test",
      async (url) =>
        String(url).includes("api.example")
          ? new Response(
              JSON.stringify({
                updated_at: "2026-07-24T00:00:00.000Z",
                download_uri: "https://data.example.test/cards.json"
              })
            )
          : new Response(JSON.stringify(cards))
    );

    await expect(client.download(["ONE"])).resolves.toMatchObject({
      cards: [expect.objectContaining({ id: "one" })]
    });
  });

  it("会重试截断的 Bulk 响应，并保留安全的长度诊断", async () => {
    let downloads = 0;
    const client = new ScryfallBulkClient(
      "https://api.example.test/bulk",
      "MTG-Market-Simulator/test",
      async (url) => {
        if (String(url).includes("api.example"))
          return new Response(
            JSON.stringify({
              updated_at: "2026-07-24T00:00:00.000Z",
              download_uri: "https://data.example.test/cards.json"
            })
          );
        downloads += 1;
        return new Response("[", { headers: { "content-length": "2" } });
      }
    );

    await expect(client.download()).rejects.toThrow("响应长度为 1 字节，预期 2 字节");
    expect(downloads).toBe(3);
  });
});
