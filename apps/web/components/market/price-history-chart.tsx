"use client";

import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts";
import styles from "./price-history-chart.module.css";

/**
 * I17F 双折线图表。只接收服务端已按自然日采样的序列，浏览器不插值、不重算。
 * null 点用 connectNulls=false 明确断开，提示该日缺失外部参考价或游戏内报价。
 */

export type ChartSeries = {
  /** 服务端 series 名（图表图例）。 */
  name: string;
  /** 与 dates 等长的数值数组；null 表示该日缺失，断线显示。 */
  values: Array<number | null>;
  /** 该序列货币/单位的中文名，用于 tooltip 与图例说明。 */
  unitLabel: string;
  /** 该序列在图表中的颜色；与 .swatch* 保持一致以便无障碍对照。 */
  color: string;
  /** 可选的服务端来源说明，渲染在图例区下方。 */
  sourceNote?: string;
};

type TooltipPoint = { seriesName: string; axisValueLabel?: string; name?: string; value: [string, number | null] | number | null; marker?: string };

function tooltipFormatter(series: ChartSeries[], params: TooltipPoint | TooltipPoint[]): string {
  // params 可能是单点或数组（trigger:axis 时为数组）。
  const list = Array.isArray(params) ? params : [params];
  const first = list[0];
  if (!first) return "";
  const date = first.axisValueLabel ?? first.name ?? "";
  const lines = list.map((point) => {
    const match = series.find((item) => item.name === point.seriesName);
    if (!match) return "";
    const value = Array.isArray(point.value) ? point.value[1] : point.value;
    return `${point.marker ?? ""} ${match.name}：${value === null || value === undefined ? "当日无快照" : value}`;
  });
  return `<div style="font-weight:700;margin-bottom:4px">${date}</div>${lines.join("<br/>")}`;
}

/** ECharts canvas 双曲线。aria-label 由父组件传入该范围的服务端事实摘要。 */
export function DualLineChart({ dates, series, ariaLabel, fallback }: {
  dates: string[];
  series: ChartSeries[];
  ariaLabel: string;
  /** 无历史或查询失败时由父组件传入降级表格；有此值时不渲染图表。 */
  fallback?: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  const option = useMemo<echarts.EChartsOption>(() => ({
    grid: { left: 56, right: 24, top: 16, bottom: 48, containLabel: true },
    tooltip: { trigger: "axis", formatter: (params) => tooltipFormatter(series, params as TooltipPoint | TooltipPoint[]) },
    legend: { show: false },
    xAxis: { type: "category", data: dates, boundaryGap: false, axisLabel: { color: "#a9a08a" } },
    yAxis: { type: "value", axisLabel: { color: "#a9a08a" }, splitLine: { lineStyle: { color: "rgba(236, 228, 208, 0.1)" } } },
    series: series.map((item) => ({
      name: item.name, type: "line", data: item.values, connectNulls: false,
      smooth: false, symbol: "circle", symbolSize: 6,
      itemStyle: { color: item.color }, lineStyle: { color: item.color, width: 2 }
    })),
    dataZoom: dates.length > 14 ? [{ type: "inside" }, { type: "slider", height: 18 }] : []
  }), [dates, series]);

  useEffect(() => {
    if (!containerRef.current || fallback !== undefined) return;
    if (!chartRef.current) chartRef.current = echarts.init(containerRef.current);
    chartRef.current.setOption(option, { notMerge: true });
    return () => { /* 同一容器跨 range 切换复用实例，仅 unmount 时销毁 */ };
  }, [option, fallback]);

  useEffect(() => {
    const onResize = () => chartRef.current?.resize();
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chartRef.current?.dispose(); chartRef.current = null; };
  }, []);

  if (fallback !== undefined) return <>{fallback}</>;

  return <div role="img" aria-label={ariaLabel}>
    <div ref={containerRef} className={styles.chart} aria-hidden="true" />
    <div className={styles.legend} aria-hidden="true">
      <ul>
        {series.map((item) => <li key={item.name}><span className={`${styles.swatch} ${item.color === "#c9a24b" ? styles.swatchReference : styles.swatchGame}`} /><span>{item.name}（{item.unitLabel}）</span></li>)}
      </ul>
    </div>
  </div>;
}
