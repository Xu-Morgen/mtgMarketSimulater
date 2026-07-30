const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

/**
 * 校验浏览器侧 API 基址：支持绝对 HTTP(S) URL（开发期直连）或以 / 开头的相对路径前缀
 * （生产期经下方 rewrites 反向代理访问 API，避免把 API 端口暴露给浏览器、免去 CORS）。
 */
function validateApiBaseUrl(value) {
  if (value.startsWith("/")) {
    if (value.includes("?") || value.includes("#")) {
      throw new Error("NEXT_PUBLIC_API_BASE_URL 相对路径不得包含查询或片段");
    }
    return value.replace(/\/+$/, "");
  }
  try {
    const url = new URL(value);
    if (!url.protocol.startsWith("http")) {
      throw new Error("API 地址必须使用 HTTP 或 HTTPS 协议");
    }
    return url.origin;
  } catch {
    throw new Error("NEXT_PUBLIC_API_BASE_URL 必须是有效的 HTTP(S) URL 或以 / 开头的相对路径");
  }
}

const normalizedApiBase = validateApiBaseUrl(apiBaseUrl);

/** 仅相对路径模式才需要服务端 rewrites；直连模式下浏览器自行请求 API origin。 */
const needsRewrite = normalizedApiBase.startsWith("/");
// 服务端代理目标（非 NEXT_PUBLIC_，不会进入浏览器）；容器内 api 服务名为 `api`。
const proxyTarget = process.env.API_PROXY_TARGET ?? "http://localhost:3001";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Playwright 可用独立构建目录，避免与开发者正在运行的 Next 服务争用 .next。
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  ...(needsRewrite
    ? {
        // 把 `${apiBaseUrl}/:path*` 反向代理到 API 服务，路径前缀被剥离。
        async rewrites() {
          return [{ source: `${normalizedApiBase}/:path*`, destination: `${proxyTarget}/:path*` }];
        }
      }
    : {})
};

export default nextConfig;
