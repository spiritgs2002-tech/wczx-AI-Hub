"use client";

/**
 * QuickFormAiDashboard —— 「AI 重排」后的数据大屏渲染器（v4：白底统一风 + recharts）。
 *
 * 与默认大屏（QuickFormDashboard）的区别：
 *   默认大屏 = 前端按字段形状**自动**决定画什么；
 *   本组件   = 按 AI 产出的**设计配置**决定画什么（选字段、选图型、排主视觉、选强调色）。
 *
 * ⚠️ 安全红线：AI 只输出**配置 JSON**（强调色只能从白名单里选，颜色一律由渲染器给出），
 *    本组件据配置自行计算并渲染图表。**绝不**让 AI 产出 HTML / 脚本 / 自由样式再渲染 ——
 *    数据源是学生自由输入，那是存储型 XSS。配置里的文案走 React 文本节点渲染，天然转义。
 *
 * v4 变更（2026-09-20，cc 定调）：
 *   - 弃用 6 套深色主题（与站点风格不搭），改为**白底统一基调 + 强调色白名单**（blue/teal/green/amber）；
 *   - 图表引擎切换为 recharts（与默认大屏共用 DashboardCharts），柱/条/饼/折线为真图表；
 *   - 布局为关键：KPI 统计卡行 + 白卡片栅格 + 主视觉双栏（span=2）；
 *   - 旧配置（aurora 等旧主题名）自动落回默认蓝，无需迁移。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  computeNumberStats,
  DEFAULT_THEME,
  SUBMITTED_AT_FIELD,
  type AiDashboardChart,
  type AiDashboardConfig,
} from "@/lib/prompts/dashboard-config";
import { ChartBar, ChartBoxPlot, MultiBoxPlot, ChartHBar, ChartLine, ChartPie, ChartScatter, GroupedCompareChart, PIE_PALETTE, type CompareSeries, type Entry } from "./DashboardCharts";
import { IDENTIFIER_KEY_HINTS, type QfRecordItem } from "./QuickFormDashboard";
import { maskDisplayName, useProjectionSafe } from "@/lib/projection-safe";

interface Props {
  records: QfRecordItem[];
  total: number;
  config: AiDashboardConfig;
  /** 全屏投屏模式：铺满视口、放大留白、只保留统计图卡（名单/词云/排行榜不占屏） */
  fullscreen?: boolean;
}

/* ------------------------------ 强调色白名单 ------------------------------ */

const ACCENTS: Record<string, string> = {
  blue: "#0052D9",
  teal: "#0891B2",
  green: "#00A870",
  amber: "#F59E0B",
};

function accentColor(theme: string | undefined): string {
  return ACCENTS[theme || ""] || ACCENTS[DEFAULT_THEME] || ACCENTS.blue;
}

/* ------------------------------ 栅格列数 / 占列 ------------------------------ */

/** gridCols → Tailwind 栅格类（移动端 1 列，lg(≥1024px) 起按配置列数；与 KPI 行断点一致） */
const GRID_COLS_CLASS: Record<number, string> = {
  2: "grid-cols-1 lg:grid-cols-2",
  3: "grid-cols-1 lg:grid-cols-3",
  4: "grid-cols-1 lg:grid-cols-4",
};

/** span → 占列类（span=1 不加类，占默认 1 列） */
const SPAN_CLASS: Record<number, string> = {
  1: "",
  2: "lg:col-span-2",
  3: "lg:col-span-3",
  4: "lg:col-span-4",
};

/** 该图实际占列数：名单永远通栏；其余按 span 夹到 1..gridCols */
function effectiveSpan(chart: AiDashboardChart, gridCols: number): number {
  if (chart.type === "roster") return gridCols;
  return Math.min(chart.span ?? 1, gridCols);
}

/* ------------------------------ 小工具（纯逻辑，勿动） ------------------------------ */

function isNumericValue(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") {
    const n = Number(v);
    return v.trim() !== "" && Number.isFinite(n);
  }
  return false;
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

/** 读某字段在单条记录下的值：「提交时间」读记录元数据 submittedAt，其余读 data */
function fieldValueOf(r: QfRecordItem, field: string): unknown {
  if (field === SUBMITTED_AT_FIELD) return r.submittedAt;
  return r.data?.[field];
}

// MUST PRESERVE MULTI MEMBERSHIP: 多选值分别计入各组；未填单独计数。
// 📐 CONTRACT: 最多八个主要组，剩余合并；🔗 RELATED: 分组 KPI 与图表。
// ⛔ DO NOT REVERT: 合并其他时同一记录去重，避免多选导致重复统计。
export function groupRecords(records: QfRecordItem[], groupBy: string): Map<string, QfRecordItem[]> {
  const groups = new Map<string, QfRecordItem[]>();
  for (const record of records) {
    const raw = fieldValueOf(record, groupBy);
    const values = Array.isArray(raw) ? raw : [raw];
    const keys = [...new Set(values.map((v) => v == null ? "" : String(v).trim()).filter(Boolean))];
    for (const key of keys.length ? keys : ["（未填）"]) groups.set(key, [...(groups.get(key) || []), record]);
  }
  const sorted = [...groups].sort((a, b) => b[1].length - a[1].length);
  if (sorted.length <= 8) return new Map(sorted);
  const top = sorted.slice(0, 8);
  const rest = [...new Set(sorted.slice(8).flatMap(([, rows]) => rows))];
  const existing = top.find(([key]) => key === "其他");
  if (existing) existing[1] = [...new Set([...existing[1], ...rest])];
  else top.push(["其他", rest]);
  return new Map(top);
}

/** 收集每个字段的非空取值（多选字段会被摊平用于计数） */
function collectValues(records: QfRecordItem[]): Map<string, unknown[]> {
  const map = new Map<string, unknown[]>();
  for (const r of records) {
    const data = r.data || {};
    for (const [k, v] of Object.entries(data)) {
      if (!k || k.startsWith("_")) continue;
      if (v === undefined || v === null) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(v);
    }
    // 「提交时间」作为一等字段纳入（数据在记录元数据，不在 data 里）
    if (r.submittedAt) {
      if (!map.has(SUBMITTED_AT_FIELD)) map.set(SUBMITTED_AT_FIELD, []);
      map.get(SUBMITTED_AT_FIELD)!.push(r.submittedAt);
    }
  }
  return map;
}

/** 计数降序 */
function counter(values: unknown[], limit: number): Entry[] {
  const m = new Map<string, number>();
  for (const v of values) {
    const k = String(v);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

/** 数值分桶：取值少（≤10 种）按原值，否则等宽 6 箱 */
function numericBuckets(nums: number[], uniqueCount: number): Entry[] {
  if (uniqueCount <= 10) {
    const m = new Map<number, number>();
    for (const n of nums) m.set(n, (m.get(n) || 0) + 1);
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([v, c]) => [fmtNum(v), c]);
  }
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (min === max) return [[fmtNum(min), nums.length]];
  const bins = 6;
  const width = (max - min) / bins;
  const buckets = new Array<number>(bins).fill(0);
  for (const n of nums) {
    let i = Math.floor((n - min) / width);
    if (i >= bins) i = bins - 1;
    if (i < 0) i = 0;
    buckets[i]++;
  }
  return buckets.map((c, i) => [`${fmtNum(min + i * width)}–${fmtNum(min + (i + 1) * width)}`, c]);
}

/** 解析某字段在本次渲染下的分组数据 */
function entriesForField(values: unknown[], limit: number): Entry[] {
  if (values.length === 0) return [];
  if (values.every((v) => Array.isArray(v))) {
    return counter(values.flat(), limit);
  }
  if (values.every(isNumericValue)) {
    const nums = values.map((v) => Number(v));
    // 数值分桶最多 6 箱（去重 ≤10 时按原值，最多 10 列），不做 limit 截断以免丢数据
    return numericBuckets(nums, new Set(nums.map((v) => String(v))).size);
  }
  return counter(values, limit);
}

/**
 * 词云专用分词：一个字段值里常含多个词（如「勤劳，无私、清凉」应按 3 个词计数），
 * 按中英文标点 + 空白拆开逐词计数；纯数字值（含小数）整体保留，避免「3.5」被拆成「3」「5」。
 * ⚠️ 仅按标点/空格切分，不做停用词过滤、不丢单字词（保持数据忠实；虚词霸榜问题留待真实数据反馈再定）。
 * 🔗 仅 AI 大屏的词云分支使用；旧手排大屏 QuickFormDashboard 的 TagCloud 未接入（保持整值口径，勿混用）。
 */
function collectWords(values: unknown[]): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    for (const w of s.split(
      /[\s,，、;；:：.。!！?？·•|/\\~～\-—_()（）[\]【】<>《》「」『』"'“”‘’]+/
    )) {
      const t = w.trim();
      if (t) out.push(t);
    }
  };
  for (const v of values) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const x of v) {
        if (x === undefined || x === null) continue;
        const s = String(x).trim();
        if (s) push(s);
      }
      continue;
    }
    const s = String(v).trim();
    if (!s) continue;
    if (isNumericValue(s)) {
      out.push(s);
      continue;
    }
    push(s);
  }
  return out;
}

/** 计算 KPI 数值（count 已在调用方按 total 处理，这里只算字段维度） */
function kpiValue(agg: string, values: unknown[]): string {
  if (agg === "count") return String(values.length);
  const nums = values.filter(isNumericValue).map((v) => Number(v));
  switch (agg) {
    case "unique":
      return String(new Set(values.map((v) => String(v))).size);
    // MUST KEEP TWO DECIMALS FOR THE MEAN: 对比 4.95 / 3.25 / 3 时不能把平均值显示成 5。
    // 📐 CONTRACT: 保留旧聚合的数值过滤；🔗 RELATED: dashboard-config.ts 的摘要 avg。
    // ⛔ DO NOT REVERT: 不沿用其他旧指标的一位小数格式。
    case "avg": {
      if (!nums.length) return "—";
      const avg = computeNumberStats(nums)?.avg;
      return avg != null && Number.isFinite(avg) ? String(avg) : "—";
    }
    case "sum":
      return nums.length ? fmtNum(nums.reduce((a, b) => a + b, 0)) : "—";
    case "max":
      return nums.length ? fmtNum(Math.max(...nums)) : "—";
    case "min":
      return nums.length ? fmtNum(Math.min(...nums)) : "—";
    // MUST KEEP MISSING VALUES DISTINCT: 新统计量只适用于数值字段，零是有效结果。
    // 📐 CONTRACT: 无统计量或无众数显示 "—"；🔗 RELATED: dashboard-config.ts 的 computeNumberStats。
    // ⛔ DO NOT REVERT: 不把 null 转成 0，也不把混合字段静默判为数值字段。
    case "median":
    case "mode":
    case "range":
    case "variance":
    case "stddev": {
      const value = nums.length === values.length ? computeNumberStats(nums)?.[agg] : undefined;
      return value != null && Number.isFinite(value) ? String(Number(value.toPrecision(14))) : "—";
    }
    default:
      return String(values.length);
  }
}

/* ------------------------------ 主题化外壳（白底统一） ------------------------------ */

function Card({
  color,
  hero,
  title,
  meta,
  note,
  children,
  fill = false,
}: {
  color: string;
  hero: boolean;
  title: string;
  meta?: string;
  note?: string;
  children: React.ReactNode;
  fill?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border bg-white shadow-sm hover:shadow-md transition-shadow p-5 h-full ${fill ? "flex flex-col min-h-0 overflow-hidden" : ""}`}
      style={{ borderColor: hero ? `${color}55` : "#f0f2f6" }}
    >
      <div className={`flex items-center justify-between gap-2 ${fill ? "shrink-0 mb-2" : "mb-4"}`}>
        <span className="flex items-center gap-2 min-w-0">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
          <span className="text-sm font-semibold text-gray-800 truncate" title={title}>
            {title}
          </span>
        </span>
        {meta && <span className="text-[11px] text-gray-400 shrink-0">{meta}</span>}
      </div>
      <div className={fill ? "flex-1 min-h-0" : undefined}>{children}</div>
      {note && <div className="text-[11px] text-gray-400 mt-3 leading-relaxed">{note}</div>}
    </div>
  );
}

/* ------------------------------ 图形 ------------------------------ */

function ColumnChart({ entries, color, fill, showValue = false }: { entries: Entry[]; color: string; fill?: boolean; showValue?: boolean }) {
  return <ChartBar entries={entries} color={color} fill={fill} showValue={showValue} />;
}

function BarList({ entries, color, showValue = false, fill }: { entries: Entry[]; color: string; showValue?: boolean; fill?: boolean }) {
  return <ChartHBar entries={entries} color={color} showValue={showValue} fill={fill} />;
}

function PieChartView({ entries }: { entries: Entry[] }) {
  return <ChartPie entries={entries} />;
}

function LineView({ entries, color, fill }: { entries: Entry[]; color: string; fill?: boolean }) {
  return <ChartLine entries={entries} color={color} fill={fill} />;
}

// MUST MASK ONLY IDENTIFIER GROUP LABELS: 树种等类别仍显示原名，分组与统计使用原始值。
// 📐 CONTRACT: 复用默认大屏字段名口径；🔗 RELATED: QuickFormDashboard.isIdentifier。
// ⛔ DO NOT REVERT: 在聚合后替换标签，不重新分组或排序。
function isIdentifierLabel(field: string): boolean {
  return IDENTIFIER_KEY_HINTS.some((hint) => field.toLowerCase().includes(hint));
}

function NameRoster({ names }: { names: string[] }) {
  const safe = useProjectionSafe();
  const LIMIT = 60;
  // MUST MASK THE TITLE TOO: 浏览器悬浮提示与显示文本共用投屏别名。
  // 📐 CONTRACT: 仅替换展示；🔗 RELATED: projection-safe.ts。
  // ⛔ DO NOT REVERT: 保持原名单计数和顺序。
  const shown = names.slice(0, LIMIT).map((name, i) => safe ? maskDisplayName(name, i) : name);
  return (
    <div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
        {shown.map((n, i) => (
          <div key={`${n}-${i}`} className="flex items-center gap-2.5 min-w-0">
            <span className="w-4 text-[11px] text-gray-300 text-right shrink-0">{i + 1}</span>
            <span className="text-[13px] text-gray-700 truncate" title={n}>
              {n}
            </span>
          </div>
        ))}
      </div>
      {names.length > LIMIT && (
        <div className="text-[11px] text-gray-400 mt-3">还有 {names.length - LIMIT} 人未显示</div>
      )}
    </div>
  );
}

function TagList({ entries, color }: { entries: Entry[]; color: string }) {
  const max = entries[0]?.[1] || 1;
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([label, count]) => {
        const weight = count / max;
        return (
          <div
            key={label}
            className="rounded-full px-3 py-1 text-xs border"
            style={{
              background: `${color}${weight > 0.66 ? "1f" : weight > 0.33 ? "12" : "08"}`,
              borderColor: `${color}33`,
            }}
          >
            <span className="text-gray-700">{label}</span>
            <span className="ml-1.5 font-semibold" style={{ color }}>
              {count}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------ 排行榜 / 词云 / 散点 ------------------------------ */

/** 竞赛排名（并列同分同名次、跳号：95/90/90/85 → 1/2/2/4） */
function RankingList({
  records,
  sortField,
  labelField,
  order,
}: {
  records: QfRecordItem[];
  sortField: string;
  labelField?: string;
  order?: "desc" | "asc";
}) {
  const safe = useProjectionSafe();
  const lf = labelField || sortField;
  const isNum = records.some((r) => isNumericValue(fieldValueOf(r, sortField)));

  const rows = records
    .map((r) => {
      const raw = fieldValueOf(r, sortField);
      const label = fieldValueOf(r, lf);
      return {
        raw,
        label: label === undefined || label === null || label === "" ? "—" : String(label),
      };
    })
    .filter((r) => r.raw !== undefined && r.raw !== null && r.raw !== "");

  const cmp = (a: { raw: unknown }, b: { raw: unknown }) => {
    if (isNum) return Number(a.raw) - Number(b.raw);
    return String(a.raw).localeCompare(String(b.raw), "zh");
  };
  const sorted = [...rows].sort((a, b) => (order === "asc" ? cmp(a, b) : cmp(b, a)));

  let rank = 1;
  const ranked = sorted.map((r, i) => {
    if (i > 0) {
      const same = isNum
        ? Number(sorted[i - 1].raw) === Number(r.raw)
        : String(sorted[i - 1].raw) === String(r.raw);
      if (!same) rank = i + 1;
    }
    const label = safe ? maskDisplayName(r.label, i) : r.label;
    const value = isNum ? fmtNum(Number(r.raw)) : String(r.raw);
    return { ...r, rank, label, value: safe && !isNum && isIdentifierLabel(sortField) ? label : value };
  });

  return (
    <div className="max-h-[360px] overflow-y-auto -mr-1 pr-1">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white">
          <tr className="text-xs text-gray-400 text-left border-b border-gray-100">
            <th className="py-2 w-14 font-normal">排名</th>
            <th className="py-2 font-normal truncate" title={lf}>
              {lf}
            </th>
            <th className="py-2 text-right font-normal truncate" title={sortField}>
              {sortField}
            </th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((r, i) => (
            <tr key={i} className="border-b border-gray-50 last:border-0">
              <td className="py-2">
                <span className={r.rank <= 3 ? "font-bold text-gray-800" : "text-gray-400"}>
                  {r.rank}
                </span>
              </td>
              <td className="py-2 text-gray-700 truncate max-w-[180px]" title={r.label}>
                {r.label}
              </td>
              <td className="py-2 text-right font-semibold text-gray-800">{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------ 词云（螺旋布局） ------------------------------ */

/** 词云卡片固定高度（px）：竖排长词 + 36px 大词需要的高度下限 */
const WORDCLOUD_HEIGHT = 210;

interface WordLayoutItem {
  label: string;
  count: number;
  /** 包围盒中心（px） */
  cx: number;
  cy: number;
  fontSize: number;
  opacity: number;
  bold: boolean;
  rotated: boolean;
}

/**
 * 词云：经典螺旋布局（阿基米德螺旋 + 矩形碰撞检测），高频词居中、字号大、颜色实，
 * 约 30% 的词竖排（旋转 90°；用确定性伪随机选词，避免每次渲染方向跳变）。
 * ⛔ DO NOT REVERT 到 flex 平铺：老师要求「真正的词云效果」（2026-10-13），平铺无旋转无密度感。
 * ⚠️ GOTCHA：布局依赖容器实际宽度，必须经 ResizeObserver 监听宽度变化重排；
 * recharts 无词云组件，此处自绘，勿为此引入新依赖。
 * 🔗 数据入口仅词云分支：counter(collectWords(values), max(limit,6))，降序传入；
 * 字号映射 12~36px（旧平铺版是 12~26px），放不下的词缩字号重试、缩到底仍放不下静默丢弃。
 */
function WordCloud({ entries, color }: { entries: Entry[]; color: string }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [words, setWords] = useState<WordLayoutItem[]>([]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    const family = getComputedStyle(box).fontFamily; // 用页面真实字体测量，避免 canvas/DOM 字体不一致

    const layout = (width: number) => {
      if (width < 40) return; // 容器不可见（display:none 等），等 ResizeObserver 再触发
      const placed: { x: number; y: number; w: number; h: number }[] = [];
      const out: WordLayoutItem[] = [];
      const max = entries[0]?.[1] || 1;

      entries.forEach(([label, count], i) => {
        const t = count / max;
        let size = Math.round(12 + t * 24); // 12 ~ 36，高频词更大
        const bold = t > 0.6;
        // 确定性伪随机竖排 ~30%；最高频词（i=0）永远横排做主视觉
        const rotated = i > 0 && (i * 137) % 10 < 3;

        for (let attempt = 0; attempt < 4; attempt++) {
          ctx.font = `${bold ? 600 : 400} ${size}px ${family}`;
          const tw = ctx.measureText(label).width + 6;
          const th = size * 1.2 + 6;
          // 竖排词：视觉包围盒宽高互换（transform rotate 围绕中心转）
          const w = rotated ? th : tw;
          const h = rotated ? tw : th;
          let ok = false;
          for (let s = 0; s < 400; s++) {
            const theta = s * 0.32;
            const r = 3 * theta;
            const cx = width / 2 + r * Math.cos(theta) * 1.5; // x 拉伸适配宽矩形
            const cy = WORDCLOUD_HEIGHT / 2 + r * Math.sin(theta);
            if (
              cx - w / 2 < 2 ||
              cx + w / 2 > width - 2 ||
              cy - h / 2 < 2 ||
              cy + h / 2 > WORDCLOUD_HEIGHT - 2
            )
              continue;
            let hit = false;
            for (const p of placed) {
              if (cx - w / 2 < p.x + p.w && cx + w / 2 > p.x && cy - h / 2 < p.y + p.h && cy + h / 2 > p.y) {
                hit = true;
                break;
              }
            }
            if (!hit) {
              placed.push({ x: cx - w / 2, y: cy - h / 2, w, h });
              out.push({ label, count, cx, cy, fontSize: size, opacity: 0.55 + t * 0.45, bold, rotated });
              ok = true;
              break;
            }
          }
          if (ok) break;
          size = Math.max(10, Math.round(size * 0.85)); // 螺旋转满仍放不下 → 缩字号重试
        }
        // 缩到 10px 仍放不下 → 静默丢弃（词云装饰性质，不挤占版面）
      });

      setWords(out);
    };

    layout(box.clientWidth);
    const ro = new ResizeObserver(() => layout(box.clientWidth));
    ro.observe(box);
    return () => ro.disconnect();
  }, [entries]);

  return (
    <div ref={boxRef} className="relative w-full select-none" style={{ height: WORDCLOUD_HEIGHT }}>
      {words.map((w) => (
        <span
          key={w.label}
          title={`${w.label} · ${w.count} 次`}
          className="absolute whitespace-nowrap"
          style={{
            left: w.cx,
            top: w.cy,
            fontSize: w.fontSize,
            color,
            opacity: w.opacity,
            fontWeight: w.bold ? 600 : 400,
            lineHeight: 1.2,
            transform: `translate(-50%, -50%) rotate(${w.rotated ? 90 : 0}deg)`,
          }}
        >
          {w.label}
        </span>
      ))}
    </div>
  );
}

/** 散点图未显式配置 groupBy 时，自动识别常见类别字段（如「组别」），让不同树种自动分色 */
function detectScatterGroupField(records: QfRecordItem[]): string | undefined {
  if (records.length < 2) return undefined;
  const candidates = new Set<string>();
  for (const r of records) for (const key of Object.keys(r.data || {})) candidates.add(key);
  for (const key of candidates) {
    if (key.startsWith("_")) continue;
    if (!/组别|树种|类别|分组|group|category|type/i.test(key)) continue;
    const values = new Set(
      records.map((r) => String(r.data?.[key] ?? "").trim()).filter(Boolean)
    );
    if (values.size >= 2 && values.size <= 12) return key;
  }
  return undefined;
}

/** 散点图：两条数值字段的相关性；有分组字段时按组着色并出图例 */
function ScatterView({
  records,
  xField,
  yField,
  labelField,
  groupBy,
  color,
  fill,
}: {
  records: QfRecordItem[];
  xField: string;
  yField: string;
  labelField?: string;
  groupBy?: string;
  color: string;
  fill?: boolean;
}) {
  const safe = useProjectionSafe();
  const points: { x: number; y: number; label?: string; group?: string }[] = [];
  const groupIndex = new Map<string, number>();
  for (const r of records) {
    const data = r.data || {};
    const x = data[xField];
    const y = data[yField];
    if (!isNumericValue(x) || !isNumericValue(y)) continue;
    const rawGroup = groupBy ? String(data[groupBy] ?? "").trim() : "";
    let group: string | undefined;
    if (rawGroup) {
      if (!groupIndex.has(rawGroup)) groupIndex.set(rawGroup, groupIndex.size);
      group = safe && isIdentifierLabel(groupBy!)
        ? maskDisplayName(rawGroup, groupIndex.get(rawGroup)!)
        : rawGroup;
    }
    points.push({
      x: Number(x),
      y: Number(y),
      label: labelField ? (safe && isIdentifierLabel(labelField) ? maskDisplayName("", points.length) : String(data[labelField] ?? "")) : undefined,
      group,
    });
  }

  if (points.length < 2) return null;
  return (
    <ChartScatter
      points={points}
      color={color}
      xLabel={xField}
      yLabel={yField}
      groupLabel={groupBy}
      fill={fill}
    />
  );
}

/* ------------------------------ 图表分发 ------------------------------ */

function ChartBody({
  chart,
  records,
  fieldValues,
  color,
  fill,
}: {
  chart: AiDashboardChart;
  records: QfRecordItem[];
  fieldValues: Map<string, unknown[]>;
  color: string;
  fill?: boolean;
}) {
  const safe = useProjectionSafe();
  const limit = chart.limit ?? 8;

  if (chart.type === "roster") {
    const values = fieldValues.get(chart.field) || [];
    const names = values.map((v) => String(v));
    if (names.length === 0) return null;
    return <NameRoster names={names} />;
  }

  if (chart.type === "ranking") {
    const sortField = chart.sortField || chart.field;
    return (
      <RankingList
        records={records}
        sortField={sortField}
        labelField={chart.labelField}
        order={chart.order}
      />
    );
  }

  if (chart.type === "scatter") {
    if (!chart.xField || !chart.yField) return null;
    return (
      <ScatterView
        records={records}
        xField={chart.xField}
        yField={chart.yField}
        labelField={chart.labelField}
        groupBy={chart.groupBy || detectScatterGroupField(records)}
        color={color}
        fill={fill}
      />
    );
  }

  const values = fieldValues.get(chart.field) || [];

  // MUST SHARE THE GROUP SAMPLE: 分组箱线与指标均从同一组记录计算，单组图保持原口径。
  // 🔗 RELATED: groupRecords、MultiBoxPlot、computeNumberStats；⛔ DO NOT REVERT: 不用全班数值替代组内值。
  if (chart.groupBy && ["boxplot", "bar", "hbar", "line"].includes(chart.type)) {
    const groups = [...groupRecords(records, chart.groupBy)];
    const grouped = groups.map(([name, rows], i) => {
      const nums = rows.map((r) => fieldValueOf(r, chart.field)).filter(isNumericValue).map(Number);
      return { name: safe && isIdentifierLabel(chart.groupBy!) ? maskDisplayName(name, i) : name, stats: nums.length >= 2 ? computeNumberStats(nums) : null, nums };
    });
    if (chart.type === "boxplot") return <MultiBoxPlot series={grouped} color={color} fill={fill} />;
    // ⛔ DO NOT REVERT: 树叶课的教学难点是「平均数被极端叶拉偏、中位数更稳健」，
    //   分组对比必须同时给出平均数与中位数双系列，学生才有依据判断「该看哪个」。
    //   只给中位数会让教案任务三「辨数」在大屏上落不了地。
    //   📐 CONTRACT: 同一组记录同时算 avg 与 median，柱顶/条末标数值；bar 竖向柱、hbar 横向条。
    const compare: CompareSeries[] = grouped.map(({ name, nums }) => {
      const stats = nums.length ? computeNumberStats(nums) : null;
      return { name, avg: stats?.avg ?? null, median: stats?.median ?? null };
    });
    if (chart.type === "line") {
      // 折线走势只看中位数（典型值），避免平均数随极端值抖动；柱状对比才用双系列。
      const entries: Entry[] = compare.filter((s) => s.median != null).map((s) => [s.name, s.median!]);
      return <LineView entries={entries} color={color} fill={fill} />;
    }
    if (chart.type === "hbar") return <GroupedCompareChart series={compare} vertical={false} fill={fill} />;
    return <GroupedCompareChart series={compare} vertical fill={fill} />;
  }

  // MUST SHARE THE SUMMARY ALGORITHM: 同一字段的箱体、中位线与 KPI 必须一致。
  // 📐 CONTRACT: 只取有效数值，至少 4 个才画；🔗 RELATED: chartHasData / ChartBoxPlot。
  // ⛔ DO NOT REVERT: 用须端点画须，不能把样本最小值和最大值直接当成须。
  if (chart.type === "boxplot") {
    const nums = values.filter(isNumericValue).map(Number);
    const stats = nums.length >= BOX_PLOT_MIN_COUNT ? computeNumberStats(nums) : null;
    return <ChartBoxPlot stats={stats ? {
      min: stats.whiskerMin, q1: stats.q1, median: stats.median, q3: stats.q3,
      max: stats.whiskerMax, outliers: stats.outliers,
    } : null} color={color} label={chart.field} />;
  }

  if (chart.type === "wordcloud") {
    // ⛔ DO NOT REVERT：词数上限曾写死 30，导致编辑器「显示条数」输入框形同虚设（2026-10-13 修复）。
    // 现按 chart.limit 生效（默认 8，编辑器/后端 sanitize 限 3~20），下限 6 与 bar/hbar/pie/line 口径一致；
    // 取值必须先经 collectWords 按标点/空格分词，否则「勤劳，无私、清凉」会被整串计为一个词。
    const maskLabels = safe && isIdentifierLabel(chart.field);
    const wcEntries = counter(collectWords(values), Math.max(limit, 6))
      .map(([name, count], i): Entry => [maskLabels ? maskDisplayName(name, i) : name, count]);
    if (wcEntries.length === 0) return null;
    return <WordCloud entries={wcEntries} color={color} />;
  }

  const maskLabels = safe && isIdentifierLabel(chart.field) && !values.every(isNumericValue);
  const entries = entriesForField(values, chart.type === "list" ? limit : Math.max(limit, 6))
    .map(([name, value], i): Entry => [maskLabels ? maskDisplayName(name, i) : name, value]);
  if (entries.length === 0) return null;

  switch (chart.type) {
    case "line":
      return <LineView entries={entries} color={color} fill={fill} />;
    case "hbar":
      return <BarList entries={entries} color={color} fill={fill} />;
    case "pie":
      return <PieChartView entries={entries} />;
    case "list":
      return <TagList entries={entries} color={color} />;
    case "bar":
    default:
      return <ColumnChart entries={entries} color={color} fill={fill} />;
  }
}

const BOX_PLOT_MIN_COUNT = 4;

/** 判断一张图在当前数据下是否有可渲染内容（ranking/scatter 走记录维度，其余走字段聚合） */
function chartHasData(
  chart: AiDashboardChart,
  records: QfRecordItem[],
  fieldValues: Map<string, unknown[]>
): boolean {
  if (chart.type === "ranking") {
    const sf = chart.sortField || chart.field;
    return records.some((r) => {
      const v = fieldValueOf(r, sf);
      return v !== undefined && v !== null && v !== "";
    });
  }
  if (chart.type === "scatter") {
    if (!chart.xField || !chart.yField) return false;
    let n = 0;
    for (const r of records) {
      const d = r.data || {};
      if (isNumericValue(d[chart.xField]) && isNumericValue(d[chart.yField])) n++;
    }
    return n >= 2;
  }
  const values = fieldValues.get(chart.field) || [];
  if (chart.type === "boxplot") return values.filter(isNumericValue).length >= BOX_PLOT_MIN_COUNT;
  return values.length > 0;
}

/* ------------------------------ 主组件 ------------------------------ */

export default function QuickFormAiDashboard({ records, total, config, fullscreen = false }: Props) {
  const safe = useProjectionSafe();
  const accent = accentColor(config.theme);
  const gridCols = config.gridCols ?? 2;
  const fieldValues = useMemo(() => collectValues(records), [records]);

  const kpis = (config.kpis || []).map((k) => {
    const values = k.field ? fieldValues.get(k.field) || [] : [];
    const shown = k.agg === "count" && !k.field ? String(total) : kpiValue(k.agg, values);
    const grouped = k.groupBy ? [...groupRecords(records, k.groupBy)].map(([name, rows], i) => ({
      name: safe && isIdentifierLabel(k.groupBy!) ? maskDisplayName(name, i) : name,
      value: k.field ? kpiValue(k.agg, rows.map((r) => fieldValueOf(r, k.field!)).filter((v) => v != null && v !== "")) : String(rows.length),
    })) : null;
    return { label: k.label, value: shown, grouped };
  });

  const charts = (config.charts || [])
    .map((c) => ({ chart: c, hasData: chartHasData(c, records, fieldValues) }))
    // MUST KEEP THE BOX PLOT CARD: 数据不足也保留卡片，由 ChartBoxPlot 提示，其他图仍按原规则过滤。
    // 📐 CONTRACT: chartHasData 仍如实返回 false；🔗 RELATED: ChartBody。
    // ⛔ DO NOT REVERT: 把所有无数据图统一过滤会吞掉箱线图的不足提示。
    .filter(({ chart, hasData }) => hasData || chart.type === "boxplot")
    // 全屏投屏只保留统计图；名单/词云/排行榜等文本卡不占屏。
    .filter(({ chart }) => !fullscreen || !["roster", "wordcloud", "list", "ranking"].includes(chart.type));

  const rosterCount = (() => {
    const roster = (config.charts || []).find((c) => c.type === "roster");
    if (!roster) return null;
    return (fieldValues.get(roster.field) || []).length;
  })();

  return (
    <div className={fullscreen
      ? "h-full w-full bg-white px-6 py-4 md:px-10 md:py-5 flex flex-col min-h-0 overflow-hidden"
      : "rounded-2xl bg-[#f7f9fc] border border-gray-100 p-4 md:p-5 space-y-4"}>
      {/* ⛔ DO NOT REVERT：按需求（2026-10-05）默认隐藏标题栏（含「AI 设计」标签），
          大屏顶部直接进图表；KPI 统计卡行已移到图表下方（见本组件底部），此处不再渲染头部两行。 */}
      {/* 图表栅格（白卡片 + 可配置列数，span 占列）。
          全屏时 flex-1 min-h-0 吃掉除 KPI 外的全部高度，内部各 Card 再按自身分配高度，整屏不滚动。 */}
      {charts.length > 0 ? (
        <div className={`grid ${GRID_COLS_CLASS[gridCols] ?? GRID_COLS_CLASS[2]} ${fullscreen ? "flex-1 min-h-0 auto-rows-fr gap-4" : "gap-4"}`}>
          {charts.map(({ chart }, i) => {
            const span = effectiveSpan(chart, gridCols);
            const hero = span === gridCols;
            const color = chart.type === "pie" ? PIE_PALETTE[0] : accent;
            return (
              <div
                key={`${chart.field}-${chart.type}-${i}`}
                className={`${SPAN_CLASS[span] ?? ""} ${fullscreen ? "h-full min-h-0" : ""}`}
              >
                <Card
                  color={chart.type === "pie" ? PIE_PALETTE[i % PIE_PALETTE.length] : color}
                  hero={hero}
                  title={chart.title || chart.field}
                  meta={chart.type === "roster" ? `名单 · 共 ${rosterCount ?? 0} 人` : undefined}
                  note={chart.note}
                  fill={fullscreen}
                >
                  <ChartBody
                    chart={chart}
                    records={records}
                    fieldValues={fieldValues}
                    color={color}
                    fill={fullscreen}
                  />
                </Card>
              </div>
            );
          })}
        </div>
      ) : kpis.length > 0 ? (
        // ⚠️ GOTCHA：charts 被 chartHasData 全部过滤、但 KPI 卡仍有值时，不要弹「没有可渲染的图表」
        // 这类误导性空态（否则老师以为配置坏了），而是提示「只有指标卡、可点编辑补图表」。
        <div className={`rounded-2xl border border-dashed border-gray-200 bg-white/60 p-6 text-center text-sm text-gray-400 ${fullscreen ? "flex-1 min-h-0 flex items-center justify-center" : ""}`}>
          大屏当前只有指标卡，没有可渲染的图表，可点上方「编辑」添加图表。
        </div>
      ) : (
        <div className={`rounded-2xl border border-dashed border-gray-200 bg-white/60 p-6 text-center text-sm text-gray-400 ${fullscreen ? "flex-1 min-h-0 flex items-center justify-center" : ""}`}>
          AI 配置里没有可渲染的图表，可点「恢复默认大屏」。
        </div>
      )}

      {/* KPI 统计卡行：按需求（2026-10-05）从大屏顶部移到图表下方（底部），顶部不再显示头部两行。
          全屏时 shrink-0 固定底部高度，不参与剩余空间分配。 */}
      {kpis.length > 0 && (
        <div className={`grid grid-cols-2 lg:grid-cols-4 ${fullscreen ? "gap-4 shrink-0 mt-4" : "gap-4"}`}>
          {kpis.map((k, i) => (
            <div
              key={`${k.label}-${i}`}
              className="rounded-2xl bg-white border border-gray-100 shadow-sm px-5 py-4 min-w-0"
            >
              <div className="text-xs text-gray-400 truncate" title={k.label}>
                {k.label}
              </div>
              {k.grouped ? <div className="mt-2 space-y-1 text-sm">{k.grouped.slice(0, 8).map((row) => <div key={row.name} className="flex justify-between gap-2"><span>{row.name}</span><strong>{row.value}</strong></div>)}{k.grouped.length > 8 && <span>…</span>}</div> : <div className="text-3xl font-bold text-gray-900 mt-1.5 truncate" title={k.value}>{k.value}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
