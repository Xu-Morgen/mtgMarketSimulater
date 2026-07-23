const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

try {
  const url = new URL(apiBaseUrl);
  if (!url.protocol.startsWith("http")) {
    throw new Error("API 地址必须使用 HTTP 或 HTTPS 协议");
  }
} catch {
  throw new Error("NEXT_PUBLIC_API_BASE_URL 必须是有效的 HTTP(S) URL");
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true
};

export default nextConfig;
