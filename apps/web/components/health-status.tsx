"use client";

import { useEffect, useState } from "react";

export function HealthStatus() {
  const [status, setStatus] = useState("检查中");

  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

    fetch(`${baseUrl}/health`)
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then(() => setStatus("API 正常（SQLite WAL）"))
      .catch(() => setStatus("API 尚未启动"));
  }, []);

  return <strong>{status}</strong>;
}
