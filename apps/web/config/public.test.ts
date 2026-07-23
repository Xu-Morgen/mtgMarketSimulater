import { describe, expect, it } from "vitest";
import { loadPublicWebConfig } from "./public";

describe("loadPublicWebConfig", () => {
  it("uses the local API default", () => {
    expect(loadPublicWebConfig({})).toEqual({ apiBaseUrl: "http://localhost:3001" });
  });

  it("rejects non-HTTP API URLs", () => {
    expect(() => loadPublicWebConfig({ NEXT_PUBLIC_API_BASE_URL: "file:///tmp/api" })).toThrow();
  });
});
