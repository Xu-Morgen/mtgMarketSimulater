import { basename } from "node:path";

/**
 * 把后端持久化的图片 cache_path 转成浏览器可访问的本地目录端点相对路径。
 * 卡图始终只经带会话的 /v1/catalog/images/:file 读取，绝不暴露外部下载地址。
 * cache_path 形如 "images/<printingId>.jpg"，此处仅取 basename，避免泄露服务端目录结构。
 */
export function publicImagePath(cachePath: string | null): string | null {
  return cachePath ? `/v1/catalog/images/${basename(cachePath)}` : null;
}
