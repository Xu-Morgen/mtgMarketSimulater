const defaultApiBaseUrl = "http://localhost:3001";

/** 使用显式字段让 Next.js 在浏览器构建时内联公开环境变量。 */
export const publicWebEnvironment = {
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL
};

export interface PublicWebConfig {
  apiBaseUrl: string;
}

/**
 * 只读取 NEXT_PUBLIC_ 前缀的变量，因此这个对象可安全进入浏览器 bundle。
 * 服务端密钥禁止在 web workspace 中读取或配置。
 *
 * 支持两种形态：
 * - 绝对 HTTP(S) URL：开发期浏览器直连 API（如 http://localhost:3001），取其 origin。
 * - 相对路径前缀：生产期经 Next.js rewrites 反向代理访问 API（如 /api），避免暴露 API 端口、
 *   免去浏览器侧 CORS。拼接形如 `${apiBaseUrl}/v1/...`，故前缀不得以 `/` 之外的字符开头，
 *   也不得包含查询或片段。
 */
export function loadPublicWebConfig(
  environment: Record<string, string | undefined>
): PublicWebConfig {
  const apiBaseUrl = (environment.NEXT_PUBLIC_API_BASE_URL ?? defaultApiBaseUrl).trim();

  // 相对路径前缀（代理模式）：仅允许以 / 开头、不含协议/主机/查询/片段的同站路径。
  if (apiBaseUrl.startsWith("/")) {
    if (apiBaseUrl.includes("?") || apiBaseUrl.includes("#")) {
      throw new Error("NEXT_PUBLIC_API_BASE_URL 相对路径不得包含查询或片段");
    }
    return { apiBaseUrl: apiBaseUrl.replace(/\/+$/, "") };
  }

  // 绝对 URL：取 origin，确保只保留协议与主机，避免把路径/查询泄漏到客户端拼接中。
  try {
    const url = new URL(apiBaseUrl);
    if (!url.protocol.startsWith("http")) {
      throw new Error("API 地址必须使用 HTTP 或 HTTPS 协议");
    }

    return { apiBaseUrl: url.origin };
  } catch {
    throw new Error("NEXT_PUBLIC_API_BASE_URL 必须是有效的 HTTP(S) URL 或以 / 开头的相对路径");
  }
}
