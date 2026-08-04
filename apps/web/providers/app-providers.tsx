"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useState } from "react";
import { SessionProvider } from "./session-provider";
import { ToastProvider } from "./toast-provider";

/** antd 暗色奇幻主题：与 styles.css 设计 Token 同源，仅换皮肤，不改语义。 */
const antdTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: "#C9A24B",
    colorInfo: "#C9A24B",
    colorBgBase: "#12151A",
    colorBgContainer: "#1C2128",
    colorBgElevated: "#272E38",
    colorBorder: "rgba(201, 162, 75, 0.32)",
    colorBorderSecondary: "rgba(236, 228, 208, 0.12)",
    colorText: "#ECE4D0",
    colorTextSecondary: "#A9A08A",
    colorTextTertiary: "#6E6757",
    colorTextDisabled: "#6E6757",
    colorSuccess: "#7FA65A",
    colorError: "#C0392B",
    colorWarning: "#D6A13E",
    colorLink: "#E6C87C",
    controlOutline: "rgba(201, 162, 75, 0.28)",
    borderRadius: 6,
    fontSize: 14,
    fontFamily: "\"Noto Sans SC\", \"PingFang SC\", \"Microsoft YaHei\", system-ui, -apple-system, sans-serif"
  },
  components: {
    Table: {
      headerBg: "#272E38",
      headerColor: "#E6C87C",
      headerSortActiveBg: "#272E38",
      headerSortHoverBg: "#2b323d",
      rowHoverBg: "rgba(201, 162, 75, 0.07)",
      colorBgContainer: "transparent",
      borderColor: "rgba(236, 228, 208, 0.08)"
    },
    Modal: {
      contentBg: "#1C2128",
      headerBg: "#1C2128",
      titleColor: "#E6C87C"
    },
    Popover: {
      colorBgElevated: "#272E38"
    },
    Descriptions: {
      colorBgContainer: "rgba(18, 21, 26, 0.45)",
      colorSplit: "rgba(236, 228, 208, 0.12)"
    },
    Pagination: {
      colorPrimary: "#C9A24B",
      colorPrimaryHover: "#E6C87C"
    },
    Spin: {
      colorPrimary: "#C9A24B"
    },
    Button: {
      colorPrimary: "#C9A24B",
      colorPrimaryHover: "#E6C87C",
      colorPrimaryActive: "#B98F3F",
      colorLink: "#E6C87C",
      colorLinkHover: "#C9A24B",
      borderColorDisabled: "rgba(201, 162, 75, 0.18)"
    },
    Tag: {
      defaultBg: "rgba(236, 228, 208, 0.08)",
      defaultColor: "#A9A08A"
    },
    Select: {
      optionSelectedBg: "rgba(201, 162, 75, 0.2)",
      optionActiveBg: "rgba(201, 162, 75, 0.12)"
    }
  }
} satisfies Parameters<typeof ConfigProvider>[0]["theme"];

export function AppProviders({ children }: Readonly<{ children: React.ReactNode }>) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } }));
  return <ConfigProvider locale={zhCN} theme={antdTheme}><QueryClientProvider client={client}><ToastProvider><SessionProvider>{children}</SessionProvider></ToastProvider></QueryClientProvider></ConfigProvider>;
}
