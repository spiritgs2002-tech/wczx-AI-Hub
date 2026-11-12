import { detectInstrumentation } from "@/lib/prompts/exploration-submit";

// 📐 CONTRACT · 本文件必须「浏览器可用」：只放纯函数与类型，禁止 import prisma / ai SDK / fs 等仅服务端模块。
// 为什么：src/app/teacher/tasks/page.tsx（"use client"）需要 parseCollectProfile。它原先直接 import
//   collect-profile.ts，连带把 @/lib/prisma 打进浏览器包；2026-11-12 prisma.ts 改为加载即包装 $connect 后，
//   浏览器端一加载就抛 "PrismaClient is unable to run in this browser environment"，教师课堂页整页白屏。
// ⛔ DO NOT import "@/lib/prisma"、"@/lib/ai" 或 collect-profile.ts 到本文件。需要数据库/AI 的逻辑放 collect-profile.ts。
// 🔗 RELATED：collect-profile.ts（re-export 本文件全部导出 + AI 分析）；src/app/teacher/tasks/page.tsx。

/**
 * 探究「采集类别清单」（Collect Profile）
 *
 * 启用提交时，先分析 HTML 决定「采哪些数据」，再按清单注入采集逻辑：
 *   - hasScoring：页面有没有「评分/计分」环节（分数、闯关得分、答题对错、评级等）。
 *                 无评分页面（纯探索/模拟/观察）不采分数，提交时 score 记 null。
 *   - hasFormControls：页面有没有标准可填控件（input/select/textarea）→ 决定是否扫描控件答案。
 *   - hasCanvas：页面有没有 <canvas> → 决定是否做画布快照。
 *
 * 为什么 hasScoring 用 AI 语义判断，而 hasFormControls/hasCanvas 用正则：
 *   - 「有没有评分环节」是语义概念（要看页面是不是在给学生打分），正则只能猜文本/变量名，
 *     易漏（自定义计分变量）也易误（页面文案带"得分"二字但无真实计分），必须 AI 判断。
 *   - 「有没有 input/canvas」是明确的 DOM 标签，正则 100% 准确，交给 AI 反而不稳。
 *
 * AI 不可用 / 失败时，用 detectCollectProfile 的正则结果兜底（偏保守，避免漏采真实分数）。
 */
export interface CollectProfile {
  hasScoring: boolean;
  hasFormControls: boolean;
  hasCanvas: boolean;
}

/**
 * 确定性检测（AI 不可用/失败时的兜底，也是 AI 结果的基座：后两项直接取这里）
 *
 * ⚠️ GOTCHA：必须在「注入前」的原始 HTML（或 AI 契约桩改造后的 HTML）上跑，
 * 不能在已注入提交功能的 HTML 上跑——注入的 basicTrackingScript 自带 `score: 0` 字样，
 * 会把无评分页面误判为有评分。
 */
export function detectCollectProfile(html: string): CollectProfile {
  const det = detectInstrumentation(html);

  // 评分信号的确定性证据，三条命中任一即视为「可能有评分」（兜底偏保守，宁多采不漏采）：
  //   1) 防御式/裸调用了 updateScore / setGameLevel（闯关计分型才会调）；
  //   2) 契约桩里给 __gameState__.score 赋值（.score= 或 ["score"]=）；
  //   3) 页面文案出现评分词（得分/分数/成绩/积分/满分/答对/答错/正确率）。
  const scoringCall =
    /typeof\s+(updateScore|setGameLevel)\s*===?\s*["']function["']/.test(html) ||
    /(?<!typeof\s)\b(updateScore|setGameLevel)\s*\(/.test(html);
  const scoreAssign = /__gameState__\s*(\.\s*score\s*=|\[\s*["']score["']\s*\]\s*=)/.test(html);
  const scoreText = /(得分|分数|成绩|积分|满分|答对|答错|正确率)/.test(html);

  return {
    hasScoring: scoringCall || scoreAssign || scoreText,
    hasFormControls: /<(input|select|textarea)\b/i.test(html),
    hasCanvas: /<canvas\b/i.test(html),
  };
}

/** 序列化/反序列化（存 ExplorationActivity.collectProfile 字段用） */
export function stringifyCollectProfile(profile: CollectProfile): string {
  return JSON.stringify(profile);
}

export function parseCollectProfile(json: string | null | undefined): CollectProfile | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    if (p && typeof p === "object" && typeof p.hasScoring === "boolean") {
      return {
        hasScoring: p.hasScoring === true,
        hasFormControls: p.hasFormControls === true,
        hasCanvas: p.hasCanvas === true,
      };
    }
    return null;
  } catch {
    return null;
  }
}
