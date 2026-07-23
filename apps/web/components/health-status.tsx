"use client";

import { useEffect, useState } from "react";
import { loadPublicWebConfig } from "../config/public";

export function HealthStatus() {
  const [status, setStatus] = useState("检查中");

  useEffect(() => {
    const { apiBaseUrl } = loadPublicWebConfig(process.env);

    fetch(`${apiBaseUrl}/health`)
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then(() => setStatus("API 正常（SQLite WAL）"))
      .catch(() => setStatus("API 尚未启动"));
  }, []);

  return <strong>{status}</strong>;
}
