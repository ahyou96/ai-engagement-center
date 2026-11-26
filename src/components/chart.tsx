"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { EChartsOption } from "echarts";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false, loading: () => <div className="skeleton h-full w-full" /> });

export const PALETTE = ["#6366f1", "#14b8a6", "#f59e0b", "#ef4444", "#8b5cf6", "#0ea5e9", "#84cc16", "#ec4899", "#64748b", "#22c55e"];

function useDark() {
  const [dark, setDark] = useState(false);
  useEffect(() => { const el = document.documentElement; const u = () => setDark(el.classList.contains("dark")); u(); const o = new MutationObserver(u); o.observe(el, { attributes: true, attributeFilter: ["class"] }); return () => o.disconnect(); }, []);
  return dark;
}

/** Themed ECharts wrapper. Pass onClick for drill-down. */
export function Chart({ option, height = 240, onClick }: { option: EChartsOption; height?: number; onClick?: (p: { name: string; seriesName?: string; value: unknown; dataIndex: number }) => void }) {
  const dark = useDark();
  const text = dark ? "#9b9ba7" : "#6b6b76", grid = dark ? "#26262d" : "#ececf0";
  const base: EChartsOption = {
    animation: false, color: PALETTE, backgroundColor: "transparent", textStyle: { color: text, fontFamily: "Inter, system-ui, sans-serif", fontSize: 11 },
    grid: { left: 8, right: 12, top: 28, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", backgroundColor: dark ? "#18181d" : "#fff", borderColor: grid, textStyle: { color: dark ? "#ececf1" : "#17171c", fontSize: 12 } },
    legend: { top: 0, right: 0, textStyle: { color: text }, itemWidth: 10, itemHeight: 10, icon: "roundRect" },
  };
  const axisStyle = { axisLine: { lineStyle: { color: grid } }, splitLine: { lineStyle: { color: grid } }, axisLabel: { color: text } };
  const merged: EChartsOption = { ...base, ...option,
    legend: option.legend ? { ...(base.legend as object), ...(option.legend as object) } : base.legend,
    tooltip: option.tooltip ? { ...(base.tooltip as object), ...(option.tooltip as object) } : base.tooltip,
    xAxis: option.xAxis ? (Array.isArray(option.xAxis) ? option.xAxis : [option.xAxis]).map((a) => ({ ...axisStyle, ...a })) : undefined,
    yAxis: option.yAxis ? (Array.isArray(option.yAxis) ? option.yAxis : [option.yAxis]).map((a) => ({ ...axisStyle, ...a })) : undefined,
  } as EChartsOption;
  return <ReactECharts option={merged} style={{ height, width: "100%" }} notMerge lazyUpdate={false} onEvents={onClick ? { click: onClick } : undefined} opts={{ renderer: "canvas" }} />;
}

export const bar = (x: string[], series: Array<{ name: string; data: number[] }>, opts: { horizontal?: boolean; stack?: boolean } = {}): EChartsOption => ({
  tooltip: { trigger: "axis" },
  [opts.horizontal ? "yAxis" : "xAxis"]: { type: "category", data: x, axisLabel: { interval: 0, width: 110, overflow: "truncate", hideOverlap: true } },
  [opts.horizontal ? "xAxis" : "yAxis"]: { type: "value" },
  series: series.map((s) => ({ ...s, type: "bar", stack: opts.stack ? "s" : undefined, barMaxWidth: 28, itemStyle: { borderRadius: opts.stack ? 0 : 3 } })),
} as EChartsOption);
export const line = (x: string[], series: Array<{ name: string; data: Array<number | null>; area?: boolean; yAxisIndex?: number }>, opts: { dualAxis?: boolean } = {}): EChartsOption => ({
  xAxis: { type: "category", data: x, boundaryGap: false }, yAxis: opts.dualAxis ? [{ type: "value" }, { type: "value", splitLine: { show: false } }] : { type: "value" },
  series: series.map((s) => ({ name: s.name, data: s.data, type: "line", smooth: true, showSymbol: false, yAxisIndex: s.yAxisIndex, areaStyle: s.area ? { opacity: 0.08 } : undefined })),
} as EChartsOption);
export const pie = (data: Array<{ name: string; value: number }>): EChartsOption => ({
  tooltip: { trigger: "item" }, legend: { orient: "vertical", right: 0, top: "middle" },
  series: [{ type: "pie", radius: ["48%", "72%"], center: ["35%", "50%"], data, label: { show: false }, itemStyle: { borderWidth: 2, borderColor: "transparent" } }],
} as EChartsOption);
