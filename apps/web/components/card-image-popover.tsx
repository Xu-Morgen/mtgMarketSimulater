"use client";

import { Popover, Spin } from "antd";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { loadPublicWebConfig, publicWebEnvironment } from "../config/public";
import { useSession } from "../providers/session-provider";
import styles from "./card-image-popover.module.css";

/**
 * 卡图悬浮预览的取图逻辑：与 CatalogCardDetailModal 的 LocalCatalogImage 一致，
 * 只经带会话的本地 API 读取，绝不把外部图片 URL 交给浏览器。
 * Popover 的内容懒渲染（仅 hover 时挂载），所以取图请求只在用户真正悬浮时才发起。
 */
function HoverCatalogImage({ path, name }: { path: string | null; name: string }) {
  const { accessToken } = useSession();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!path || !accessToken) { setImageUrl(null); setFailed(false); return; }
    let disposed = false;
    let objectUrl: string | null = null;
    void fetch(`${loadPublicWebConfig(publicWebEnvironment).apiBaseUrl}${path}`, { credentials: "include", headers: { Authorization: `Bearer ${accessToken}` } })
      .then(async (response) => { if (!response.ok) throw new Error("图片读取失败"); return response.blob(); })
      .then((blob) => { objectUrl = URL.createObjectURL(blob); if (!disposed) setImageUrl(objectUrl); })
      .catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [accessToken, path]);
  if (!path) return <div className={styles.placeholder}>暂无本地图片；管理员可按需缓存该印刷的卡图。</div>;
  if (failed) return <div className={styles.placeholder}>本地图片暂不可用。</div>;
  return imageUrl ? <img className={styles.image} src={imageUrl} alt={`${name} 卡图`} /> : <Spin tip="正在读取本地图片" />;
}

/**
 * 把任意触发器（通常是一个小图标按钮）包成悬浮卡图预览。
 * 卡图路径来自列表行已有的 imagePath，无需额外请求详情。
 */
export function CardImagePopover({ imagePath, name, children }: { imagePath: string | null; name: string; children: ReactNode }) {
  return (
    <Popover
      trigger="hover"
      placement="right"
      mouseEnterDelay={0.2}
      destroyTooltipOnHide
      content={<div className={styles.popoverContent}><HoverCatalogImage path={imagePath} name={name} /></div>}
      title={null}
    >
      {children}
    </Popover>
  );
}
