"use client";

/**
 * 课堂数据大屏 · 共用图表组件（recharts 封装）
 *
 * 默认大屏（QuickFormDashboard）与 AI 大屏（QuickFormAiDashboard）共用，
 * 保证两个大屏视觉一致。
 *
 * 设计基调（2026-09-20 与 cc 对齐的截图样稿）：
 *   - 白底浅灰画布 + 白卡片，克制、干净的「数据平台」感；
 *   - 主色品牌蓝 #0052D9，辅助 绿 #00A870 / 青 #0891B2 / 琥珀 #F59E0B；
 *   - 图表内不再玩多色循环（cc：要的是数据大平台展示，不是颜色变化）。
 */

import type { CSSProperties, ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

export type Entry = [string, number];

/** 品牌主色 */
export const BRAND_BLUE = "#0052D9";
/** 饼图取色序列（蓝系打头，绿/青/琥珀点缀，克制不花哨） */
export const PIE_PALETTE = ["#0052D9", "#2b7de8", "#69a9f0", "#00A870", "#0891B2", "#F59E0B"];
/** 散点分组取色：樟树/银杏/石楠等类别按组稳定分配，避免所有点同色 */
export const GROUP_PALETTE = ["#0052D9", "#00A870", "#F59E0B", "#0891B2", "#7C3AED", "#DB2777"];

const TOOLTIP_STYLE: CSSProperties = {
  borderRadius: 12,
  border: "1px solid #e5e7eb",
  boxShadow: "0 6px 20px rgba(15,40,80,0.10)",
  fontSize: 12,
  padding: "6px 10px",
};

const AXIS_TICK = { fontSize: 11, fill: "#8a97a8" };

/** 全屏时让 recharts 容器占满卡片可用高度；普通模式保持固定像素高度。
 *  ⛔ 用 absolute inset-0 而不是 h-full：grid 行的 auto 高度依赖内容、内容又依赖父高度会形成
 *  循环依赖，散点图这类占整行的卡片会算出 0 高度只剩标题。绝对定位直接拿到父容器的确定尺寸。 */
function ChartFrame({ fill, children }: { fill?: boolean; children: ReactNode }) {
  return fill
    ? <div className="relative h-full w-full"><div className="absolute inset-0">{children}</div></div>
    : <>{children}</>;
}

/** 垂直柱状图（数值分布 / 时间线共用）：圆角柱 + 悬浮提示 */
export function ChartBar({
  entries,
  color = BRAND_BLUE,
  height = 220,
  fill = false,
  showValue = false,
}: {
  entries: Entry[];
  color?: string;
  height?: number;
  fill?: boolean;
  /** 分组对比图：在每根柱子顶端显示数值（保留两位小数） */
  showValue?: boolean;
}) {
  const data = entries.map(([label, count]) => ({ label, count }));
  return (
    <ChartFrame fill={fill}>
      <ResponsiveContainer width="100%" height={fill ? "100%" : height}>
        <BarChart data={data} margin={{ top: showValue ? 26 : 8, right: 4, left: -22, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" vertical={false} />
          <XAxis
            dataKey="label"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: "#e5e9f0" }}
            interval="preserveStartEnd"
            minTickGap={16}
          />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: "rgba(0,82,217,0.06)" }}
            contentStyle={TOOLTIP_STYLE}
            formatter={(v) => [`${v}`, "数量"]}
          />
          <Bar dataKey="count" fill={color} radius={[6, 6, 0, 0]} maxBarSize={46}>
            {showValue && (
              <LabelList
                dataKey="count"
                position="top"
                fill="#374151"
                fontSize={12}
                fontWeight={600}
                formatter={(v: unknown) => Number(v).toFixed(2)}
              />
            )}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** 横向条形图（低基数选项 / 多选 Top N 共用）：左标签右条 */
export function ChartHBar({
  entries,
  color = BRAND_BLUE,
  showPercent = true,
  showValue = false,
  fill = false,
}: {
  entries: Entry[];
  color?: string;
  showPercent?: boolean;
  /** 分组对比图：在每根条形末端显示数值（保留两位小数） */
  showValue?: boolean;
  fill?: boolean;
}) {
  const total = entries.reduce((s, [, c]) => s + c, 0) || 1;
  const data = entries.map(([label, count]) => ({
    label,
    count,
    display: Number.isInteger(count) ? String(count) : String(Math.round(count * 100) / 100),
  }));
  const height = Math.max(entries.length * 34 + 16, 96);
  return (
    <ChartFrame fill={fill}>
    <ResponsiveContainer width="100%" height={fill ? "100%" : height}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 36, left: 0, bottom: 0 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          width={92}
          tickFormatter={(v: string) => (v.length > 8 ? `${v.slice(0, 8)}…` : v)}
          tick={{ fontSize: 12, fill: "#4b5563" }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          cursor={{ fill: "rgba(0,82,217,0.05)" }}
          contentStyle={TOOLTIP_STYLE}
          formatter={(v, _n, item) => {
            const c = Number(v) || 0;
            const pct = showPercent ? `（${Math.round((c / total) * 100)}%）` : "";
            return [`${c}${pct}`, "数量"];
          }}
        />
        <Bar dataKey="count" fill={color} radius={[0, 6, 6, 0]} maxBarSize={18} background={{ fill: "#f3f5f9", radius: 6 }}>
          {data.map((d, i) => (
            <Cell key={i} fill={i === 0 ? color : `${color}b8`} />
          ))}
          {showValue && (
            <LabelList
              dataKey="display"
              position="right"
              fill="#374151"
              fontSize={11}
              formatter={(v: unknown) => `${v}`}
            />
          )}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
    </ChartFrame>
  );
}

/** 环形图（取值 3~6 种的占比）：图 + 右侧图例 */
export function ChartPie({ entries }: { entries: Entry[] }) {
  const data = entries.map(([label, count]) => ({ label, count }));
  const total = entries.reduce((s, [, c]) => s + c, 0) || 1;
  return (
    <div className="flex items-center gap-4">
      <div className="w-40 h-40 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [`${v}`, "数量"]} />
            <Pie
              data={data}
              dataKey="count"
              nameKey="label"
              innerRadius="58%"
              outerRadius="88%"
              paddingAngle={2}
              stroke="none"
            >
              {data.map((d, i) => (
                <Cell key={i} fill={PIE_PALETTE[i % PIE_PALETTE.length]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="flex-1 space-y-1.5 min-w-0">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span
              className="w-2.5 h-2.5 rounded-sm shrink-0"
              style={{ background: PIE_PALETTE[i % PIE_PALETTE.length] }}
            />
            <span className="text-gray-600 truncate" title={d.label}>
              {d.label}
            </span>
            <span className="ml-auto shrink-0 text-gray-400">
              {d.count} · {Math.round((d.count / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 折线图（数值走势 / 时间序列） */
export function ChartLine({
  entries,
  color = BRAND_BLUE,
  height = 220,
  fill = false,
}: {
  entries: Entry[];
  color?: string;
  height?: number;
  fill?: boolean;
}) {
  const data = entries.map(([label, count]) => ({ label, count }));
  return (
    <ChartFrame fill={fill}>
    <ResponsiveContainer width="100%" height={fill ? "100%" : height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: "#e5e9f0" }} interval="preserveStartEnd" />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [`${v}`, "数量"]} />
        <Line
          type="monotone"
          dataKey="count"
          stroke={color}
          strokeWidth={2.5}
          dot={{ r: 3, fill: "#ffffff", stroke: color, strokeWidth: 2 }}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    </ResponsiveContainer>
    </ChartFrame>
  );
}

/** 散点图（两个数值字段的相关性）：recharts ScatterChart，hover 显示标签 */
export function ChartScatter({
  points,
  color = BRAND_BLUE,
  xLabel,
  yLabel,
  groupLabel,
  height = 220,
  fill = false,
}: {
  points: { x: number; y: number; label?: string; group?: string }[];
  color?: string;
  xLabel?: string;
  yLabel?: string;
  /** 分组字段名（如「组别」）：有值时按组着色并显示图例 */
  groupLabel?: string;
  height?: number;
  fill?: boolean;
}) {
  // 按组拆成多个 Scatter 系列：recharts 自动给图例、tooltip 分色，颜色稳定按首次出现顺序分配。
  const grouped = new Map<string, { x: number; y: number; label?: string; group?: string }[]>();
  for (const p of points) {
    const key = p.group ?? "";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push({ x: p.x, y: p.y, label: p.label, group: p.group });
  }
  const series = [...grouped.entries()];
  const hasGroups = series.length > 1 && series.some(([name]) => name);
  // recharts v3 的 Tooltip content 类型较复杂，这里用宽松类型只做读取
  const renderTooltip = (props: any) => {
    const { active, payload } = props;
    if (!active || !payload || !payload.length) return null;
    const p = payload[0].payload;
    const seriesColor = payload[0]?.color || BRAND_BLUE;
    return (
      <div
        style={{
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          boxShadow: "0 6px 20px rgba(15,40,80,0.10)",
          fontSize: 12,
          padding: "6px 10px",
        }}
      >
        {p?.label && (
          <div style={{ fontWeight: 600, color: "#374151", marginBottom: 2 }}>{p.label}</div>
        )}
        {p?.group && (
          <div style={{ color: seriesColor, marginBottom: 2 }}>
            {groupLabel || "组别"}：{p.group}
          </div>
        )}
        <div style={{ color: "#6b7280" }}>
          {xLabel || "x"}：{p?.x}
        </div>
        <div style={{ color: "#6b7280" }}>
          {yLabel || "y"}：{p?.y}
        </div>
      </div>
    );
  };

  return (
    <ChartFrame fill={fill}>
    <ResponsiveContainer width="100%" height={fill ? "100%" : height}>
      <ScatterChart margin={{ top: hasGroups ? 30 : 8, right: 16, left: 0, bottom: 12 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef1f6" />
        <XAxis
          type="number"
          dataKey="x"
          name={xLabel || "x"}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: "#e5e9f0" }}
          domain={["auto", "auto"]}
          label={
            xLabel
              ? { value: xLabel, position: "insideBottom", offset: -6, fontSize: 11, fill: "#8a97a8" }
              : undefined
          }
        />
        <YAxis
          type="number"
          dataKey="y"
          name={yLabel || "y"}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          domain={["auto", "auto"]}
          label={
            yLabel
              ? { value: yLabel, position: "insideLeft", angle: -90, fontSize: 11, fill: "#8a97a8" }
              : undefined
          }
        />
        <ZAxis range={[80, 80]} />
        <Tooltip content={renderTooltip} cursor={{ strokeDasharray: "3 3" }} />
        {series.map(([name, rows], i) => (
          <Scatter
            key={name || "all"}
            name={name || "样本"}
            data={rows}
            fill={hasGroups ? GROUP_PALETTE[i % GROUP_PALETTE.length] : color}
          />
        ))}
        {hasGroups && (
          <Legend
            verticalAlign="top"
            align="right"
            height={24}
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 11, color: "#6b7280" }}
          />
        )}
      </ScatterChart>
    </ResponsiveContainer>
    </ChartFrame>
  );
}

// MUST USE THE WHISKER ENDPOINTS: 箱外的离群点独立画，数轴仍覆盖可见数据范围。
// 📐 CONTRACT: min / max 是须端点；空统计显示提示，等值样本退化为一个点。
// 🔗 RELATED: QuickFormAiDashboard.ChartBody 和 dashboard-config.computeNumberStats。
// ⛔ DO NOT REVERT: 保留 20 点上限，坐标域为零时禁止除零。
export function ChartBoxPlot({
  stats,
  color = BRAND_BLUE,
  label,
}: {
  stats: { min: number; q1: number; median: number; q3: number; max: number; outliers: number[] } | null;
  color?: string;
  label: string;
}) {
  if (!stats) {
    return <div className="py-8 text-center text-sm text-gray-500">数据不足，无法绘制箱线图</div>;
  }

  const { min, q1, median, q3, max, outliers } = stats;
  const low = Math.min(min, ...outliers);
  const high = Math.max(max, ...outliers);
  const constant = low === high;
  const magnitude = Math.max(Math.abs(low), Math.abs(high), 1);
  const span = high - low;
  const x = (value: number) => {
    if (constant) return 200;
    const position = Number.isFinite(span)
      ? (value - low) / span
      : (value / magnitude - low / magnitude) / (high / magnitude - low / magnitude);
    return 36 + 328 * position;
  };
  const format = (value: number) => new Intl.NumberFormat("zh-CN", {
    maximumSignificantDigits: 10,
  }).format(value);
  const marks = [
    { label: "下须", value: min },
    { label: "Q1", value: q1 },
    { label: "中位数", value: median },
    { label: "Q3", value: q3 },
    { label: "上须", value: max },
  ];
  const summary = marks.map((mark) => `${mark.label} ${format(mark.value)}`).join(" · ");
  const ticks = constant ? [low] : [low, low / 2 + high / 2, high];
  const visibleOutliers = outliers.slice(0, 20);

  return (
    <div>
      <svg viewBox="0 0 400 116" className="mx-auto block w-full max-w-xl" role="img" aria-label={`${label}箱线图：${summary}`}>
        <line x1={36} x2={364} y1={86} y2={86} stroke="#e5e9f0" />
        {ticks.map((tick, index) => (
          <g key={index}>
            <line x1={x(tick)} x2={x(tick)} y1={86} y2={91} stroke="#8a97a8" />
            <text x={x(tick)} y={107} textAnchor={constant || index === 1 ? "middle" : index === 0 ? "start" : "end"} {...AXIS_TICK}>
              {format(tick)}
            </text>
          </g>
        ))}
        {constant ? (
          <circle cx={x(median)} cy={43} r={5} fill={color}><title>{summary}</title></circle>
        ) : (
          <g stroke={color} strokeWidth={2}>
            <line x1={x(min)} x2={x(q1)} y1={43} y2={43}><title>{`下须 ${format(min)}`}</title></line>
            <line x1={x(q3)} x2={x(max)} y1={43} y2={43}><title>{`上须 ${format(max)}`}</title></line>
            <rect x={x(q1)} y={28} width={x(q3) - x(q1)} height={30} fill={color} fillOpacity={0.15}>
              <title>{summary}</title>
            </rect>
            {marks.map(({ label: name, value }, index) => (
              <line key={name} x1={x(value)} x2={x(value)} y1={index === 0 || index === 4 ? 35 : 28} y2={index === 0 || index === 4 ? 51 : 58} strokeWidth={index === 2 ? 3 : 2}>
                <title>{`${name} ${format(value)}`}</title>
              </line>
            ))}
          </g>
        )}
        {visibleOutliers.map((value, index) => (
          <circle key={index} cx={x(value)} cy={43} r={4} fill={color}>
            <title>{`离群点 ${format(value)}`}</title>
          </circle>
        ))}
      </svg>
      {outliers.length > visibleOutliers.length && (
        <p className="text-center text-xs text-gray-500">另有 {outliers.length - visibleOutliers.length} 个离群点</p>
      )}
    </div>
  );
}


// MUST SHARE THE AXIS: 所有组共享数值范围，须取 Tukey 端点，离群点独立显示。
// 📐 CONTRACT: 竖向布局（树种在 X 轴、数值在 Y 轴）；每组配色与散点图一致；少于两条的组保留名称。
// 🔗 RELATED: QuickFormAiDashboard.groupRecords、GROUP_PALETTE；⛔ DO NOT REVERT: 不把原始最大最小值当须，不删除无数据组。
export function MultiBoxPlot({ series, color = BRAND_BLUE, fill = false }: {
  series: { name: string; stats: { count: number; q1: number; median: number; q3: number; whiskerMin: number; whiskerMax: number; outliers: number[] } | null }[];
  color?: string;
  fill?: boolean;
}) {
  const valid = series.flatMap(({ stats }) => stats ? [stats.whiskerMin, stats.whiskerMax, ...stats.outliers] : []);
  const low = valid.length ? Math.min(...valid) : 0;
  const high = valid.length ? Math.max(...valid) : 0;

  const W = 500, H = 300;
  const left = 56, right = 18, top = 24, bottom = 52;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  // 数值越大越靠上（SVG y 轴向下）
  const y = (v: number) => high === low
    ? top + plotH / 2
    : top + plotH * (1 - (v - low) / (high - low));
  const fmt = (v: number) => new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 8 }).format(v);
  const slot = plotW / Math.max(series.length, 1);
  const boxW = Math.min(52, slot * 0.5);
  const ticks = high === low ? [low] : [low, (low + high) / 2, high];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={fill ? "w-full h-full" : "w-full"} preserveAspectRatio="xMidYMid meet" role="img" aria-label="竖向分组箱线图">
      {/* 共享 Y 轴刻度与网格 */}
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={left} x2={W - right} y1={y(t)} y2={y(t)} stroke="#eef1f6" strokeDasharray="3 3" />
          <text x={left - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#8a97a8">{fmt(t)}</text>
        </g>
      ))}
      <line x1={left} x2={W - right} y1={top + plotH} y2={top + plotH} stroke="#e5e9f0" />

      {series.map(({ name, stats }, i) => {
        const cx = left + slot * (i + 0.5);
        const c = series.length > 1 ? GROUP_PALETTE[i % GROUP_PALETTE.length] : color;
        return (
          <g key={name}>
            <text x={cx} y={H - 14} textAnchor="middle" fontSize="12" fill="#4b5563">{name}</text>
            {stats ? (
              <g stroke={c} strokeWidth={2}>
                <title>{`${name}：下须 ${stats.whiskerMin}，Q1 ${stats.q1}，中位数 ${stats.median}，Q3 ${stats.q3}，上须 ${stats.whiskerMax}`}</title>
                {/* 上下须与端帽 */}
                <line x1={cx} x2={cx} y1={y(stats.whiskerMax)} y2={y(stats.whiskerMin)} />
                <line x1={cx - boxW * 0.32} x2={cx + boxW * 0.32} y1={y(stats.whiskerMax)} y2={y(stats.whiskerMax)} />
                <line x1={cx - boxW * 0.32} x2={cx + boxW * 0.32} y1={y(stats.whiskerMin)} y2={y(stats.whiskerMin)} />
                {/* 箱体：Q3 在上、Q1 在下 */}
                <rect
                  x={cx - boxW / 2}
                  y={y(stats.q3)}
                  width={boxW}
                  height={Math.max(0, y(stats.q1) - y(stats.q3))}
                  fill={c}
                  fillOpacity="0.15"
                />
                {/* 中位数线 */}
                <line x1={cx - boxW / 2} x2={cx + boxW / 2} y1={y(stats.median)} y2={y(stats.median)} strokeWidth={3} />
                {stats.outliers.slice(0, 10).map((value, j) => (
                  <circle key={j} cx={cx} cy={y(value)} r="3" fill={c} stroke="#fff" strokeWidth={0.8}>
                    <title>{`离群点 ${value}`}</title>
                  </circle>
                ))}
              </g>
            ) : (
              <text x={cx} y={top + plotH / 2} textAnchor="middle" fill="#888" fontSize="11">数据不足</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
