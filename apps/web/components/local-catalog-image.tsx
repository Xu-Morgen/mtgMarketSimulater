"use client";

import { Spin } from "antd";
import { useEffect, useState } from "react";
import { loadPublicWebConfig, publicWebEnvironment } from "../config/public";
import { useSession } from "../providers/session-provider";
import styles from "./local-catalog-image.module.css";

/**
 * I33F：开包结果/目录详情等复用同一只读卡图。只经带会话的本地 API 读取，
 * 绝不把外部图片 URL 交给浏览器；稀有度卡框由全局 `.card-frame[data-rarity]` 驱动。
 * 缺图时文字降级，不访问任何外部 Provider。
 */
export function LocalCatalogImage({
  path,
  name,
  rarity
}: {
  path: string | null;
  name: string;
  rarity?: string | undefined;
}) {
  const { accessToken } = useSession();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!path || !accessToken) {
      setImageUrl(null);
      setFailed(false);
      return;
    }
    let disposed = false;
    let objectUrl: string | null = null;
    void fetch(`${loadPublicWebConfig(publicWebEnvironment).apiBaseUrl}${path}`, {
      credentials: "include",
      headers: { Authorization: `Bearer ${accessToken}` }
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("图片读取失败");
        return response.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (!disposed) setImageUrl(objectUrl);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [accessToken, path]);
  const frame = (child: React.ReactNode) => (
    <div className="card-frame" data-rarity={rarity?.toLowerCase()}>
      {child}
    </div>
  );
  if (!path)
    return <div className={styles.placeholder}>暂无本地图片；管理员可按需缓存该印刷的卡图。</div>;
  if (failed) return <div className={styles.placeholder}>本地图片暂不可用。</div>;
  return imageUrl
    ? frame(<img className={styles.image} src={imageUrl} alt={`${name} 卡图`} />)
    : frame(<Spin tip="正在读取本地图片" />);
}
