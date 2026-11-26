import type { FrameworkData } from "@/lib/research/framework-diagram";

export const CASE_SECTIONS = {
  summary: "案例摘要", practice: "主要做法", outcomes: "成果成效", experience: "经验总结",
} as const;
export const CASE_THEMES = {
  AGENT_DESIGN: "智能体赋能教师教学设计与资源开发",
  HUMAN_AI: "基于大模型的人机协同教学",
  LEARNING_BY_DOING: "科学教育“做中学”",
  KINDERGARTEN_SELF_EVALUATION: "自我评价赋能幼儿园",
} as const;
export const DEFAULT_CASE_THEMES = ["HUMAN_AI", "LEARNING_BY_DOING"] as const;

export interface CaseStudyContent {
  title: string;
  summary: string;
  practice: string;
  outcomes: string;
  experience: string;
  framework: FrameworkData;
  dataGaps: string[];
}

// MUST KEEP THE JSON CONTRACT: 案例预览和 Word 共用纯文本，模式图仅消费结构化字段。
// 📐 CONTRACT: 成效数字由服务端按指标编号填入；🔗 RELATED: case-study-generator.ts。
// ⛔ DO NOT REVERT: 禁止模型直接输出 HTML、图片或未经核验的成效数字。
export function buildCaseStudyPrompt(snapshot: unknown, topic: string, themes: string[]) {
  return {
    system: `你是教育案例撰写专家，熟悉人工智能赋能课堂教学展评体例。
只输出 [CASE_JSON_START] 和 [CASE_JSON_END] 包裹的 JSON。不要解释文字、HTML 或 Markdown 图片。
字段：title, summary, practice, outcomes, experience, framework: {rows: [{phase,content,subPoints,methods}]}, dataGaps: string[]。
摘要200–300字（目标220–260），主要做法900–1200（目标950–1050），成果成效300–400（目标320–360），经验总结300–400（目标320–360）。全文目标1750–2000且不得超过2000个汉字。
主要做法分“模式提炼”和“具体做法”两节。模式图用4–6行，每行2–3个subPoints及至少一个methods，可参考课前画像、采数、现数、辨数、用数、评价。
只能使用匿名称谓，如某同学。不要编造课堂活动或成效，把尚未落实的做法写成建议。
成效数字必须有快照证据。数字和指标将由服务端添加，请在成效正文只写定性分析，不输出数字、人次、百分比或声称未经验证的提升。缺数据写【待补实测数据：项目名】并列入dataGaps。`,
    prompt: JSON.stringify({ topic, themes, snapshot }),
  };
}

export function cleanCaseText(value: unknown, max = 12000): string {
  return typeof value === "string"
    ? value.replace(/!\[[^\]]*\]\([^\n]*\)|!\[\[[^\]]*\]\]|<[^>]*>/g, "").trim().slice(0, max)
    : "";
}

export function parseCaseStudy(text: string): CaseStudyContent {
  const block = text.match(/\[CASE_JSON_START\]([\s\S]*?)\[CASE_JSON_END\]/)?.[1];
  try {
    if (!block) throw new Error();
    // Preserve URLs and comment-like text inside JSON strings.
    const json = block.replace(/^\s*```(?:json)?|\`\`\`\s*$/gi, "").replace(
      /"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|,(?=\s*[}\]])/g,
      (token) => token.startsWith('"') ? token : "",
    );
    const value = JSON.parse(json);
    const sections = Object.fromEntries(Object.keys(CASE_SECTIONS).map((key) => [key, cleanCaseText(value[key])]));
    if (Object.values(sections).some((part) => !part)) throw new Error();
    const list = (items: unknown, max: number, size: number) => Array.isArray(items)
      ? items.map((item) => cleanCaseText(item, size)).filter(Boolean).slice(0, max)
      : [];
    const rows = Array.isArray(value.framework?.rows) ? value.framework.rows.slice(0, 6).map((row: Record<string, unknown> | null) => ({
      phase: cleanCaseText(row?.phase, 8),
      content: cleanCaseText(row?.content, 60),
      subPoints: list(row?.subPoints, 3, 14),
      methods: list(row?.methods, 4, 14),
    })) : [];
    return {
      title: cleanCaseText(value.title, 120),
      summary: sections.summary, practice: sections.practice, outcomes: sections.outcomes, experience: sections.experience,
      framework: { rows }, dataGaps: list(value.dataGaps, 12, 60),
    };
  } catch {
    throw Object.assign(new Error("AI 返回内容未能解析为展评案例"), { kind: "PARSE" });
  }
}
