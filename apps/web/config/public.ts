const defaultApiBaseUrl = "http://localhost:3001";

export interface PublicWebConfig {
  apiBaseUrl: string;
}

/**
 * 只读取 NEXT_PUBLIC_ 前缀的变量，因此这个对象可安全进入浏览器 bundle。
 * 服务端密钥禁止在 web workspace 中读取或配置。
 */
export function loadPublicWebConfig(
  environment: Record<string, string | undefined>
): PublicWebConfig {
  const apiBaseUrl = environment.NEXT_PUBLIC_API_BASE_URL ?? defaultApiBaseUrl;

  try {
    const url = new URL(apiBaseUrl);
    if (!url.protocol.startsWith("http")) {
      throw new Error("API 地址必须使用 HTTP 或 HTTPS 协议");
    }

    return { apiBaseUrl: url.origin };
  } catch {
    throw new Error("NEXT_PUBLIC_API_BASE_URL 必须是有效的 HTTP(S) URL");
  }
}
