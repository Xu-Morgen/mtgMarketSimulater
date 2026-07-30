import { describe, expect, it } from "vitest";
import { loadPublicWebConfig } from "./public";

describe("loadPublicWebConfig", () => {
  it("uses the local API default", () => {
    expect(loadPublicWebConfig({})).toEqual({ apiBaseUrl: "http://localhost:3001" });
  });

  it("rejects non-HTTP API URLs", () => {
    expect(() => loadPublicWebConfig({ NEXT_PUBLIC_API_BASE_URL: "file:///tmp/api" })).toThrow();
  });

  it("accepts a relative path prefix for the reverse-proxy mode", () => {
    expect(loadPublicWebConfig({ NEXT_PUBLIC_API_BASE_URL: "/api" })).toEqual({ apiBaseUrl: "/api" });
  });

  it("trims a trailing slash on the relative path prefix", () => {
    expect(loadPublicWebConfig({ NEXT_PUBLIC_API_BASE_URL: "/api/" })).toEqual({ apiBaseUrl: "/api" });
  });

  it("rejects a relative prefix containing a query or fragment", () => {
    expect(() => loadPublicWebConfig({ NEXT_PUBLIC_API_BASE_URL: "/api?x=1" })).toThrow();
    expect(() => loadPublicWebConfig({ NEXT_PUBLIC_API_BASE_URL: "/api#frag" })).toThrow();
  });
});
