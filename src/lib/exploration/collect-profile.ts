import { prisma } from "@/lib/prisma";
import { createDashScopeClient } from "@/lib/ai";
import { generateText } from "ai";
import type { CollectProfile } from "./collect-profile-core";

// ⚠️ GOTCHA · 本文件仅限服务端（依赖 prisma 与 AI SDK）。客户端组件（"use client"）只能 import
//   "./collect-profile-core"，否则 prisma 被打进浏览器包导致整页白屏（2026-11-12 教师课堂页实测）。
// 🔗 RELATED：collect-profile-core.ts（纯函数与类型，在此 re-export，服务端旧引用无需改动）。
export type { CollectProfile } from "./collect-profile-core";
export { detectCollectProfile, stringifyCollectProfile, parseCollectProfile } from "./collect-profile-core";

/**
 * AI 语义分析：判断页面有没有「评分/计分」环节（主通道）。
 * 成功返回 CollectProfile，失败（无 API Key / 解析失败 / 超时异常）返回 null，调用方走 detectCollectProfile 兜底。
 */
export async function analyzeCollectProfileWithAi(html: string): Promise<CollectProfile | null> {
  try {
    const config = await prisma.systemConfig.findFirst();
    if (!config?.aiApiKey) return null;

    const prompt =
      "分析下面这个「互动探究」网页，判断它是否包含【评分/计分】环节。\n" +
      "有评分：页面会给学生打分/计分/评级/排名——例如做题得分、选择题判断题计分、闯关得分、答对得分、星级评分、得分榜、正确率、成绩等。\n" +
      "无评分：纯探索/观察/模拟类页面——学生只是拖参数、点按钮、观察现象、看图形变化，页面不给分数，也没有\"得分\"概念。\n" +
      "判断依据是页面是否存在\"给学生打分的机制\"，而不是页面文案里是否恰好出现\"分\"字。\n\n" +
      "只输出一个 JSON，不要任何额外文字：\n" +
      '{"hasScoring": true 或 false}\n\n' +
      "HTML 内容：\n" +
      html.substring(0, 8000);

    const { chatModel } = await createDashScopeClient();
    const { text } = await generateText({
      model: chatModel,
      system: "你是一个 HTML 交互分析助手，擅长判断网页是否存在评分/计分机制。",
      prompt,
      temperature: 0.1,
    });

    // 解析 JSON（AI 可能包裹 ```json 或前后有多余文字）
    let parsed: { hasScoring?: boolean } | null = null;
    try {
      parsed = JSON.parse(text.replace(/```json\n?|```\n?/g, "").trim());
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          parsed = null;
        }
      }
    }

    if (!parsed || typeof parsed.hasScoring !== "boolean") return null;

    return {
      hasScoring: parsed.hasScoring,
      hasFormControls: /<(input|select|textarea)\b/i.test(html),
      hasCanvas: /<canvas\b/i.test(html),
    };
  } catch {
    return null;
  }
}
