import { generateText } from "ai";
import { createDashScopeClient } from "@/lib/ai";
import { aiQueue } from "@/lib/ai-queue";
import { prisma } from "@/lib/prisma";
import { collectResearchData, type ResearchDataSnapshot } from "@/lib/research/data-collector";
import { buildCaseStudyPrompt, CASE_SECTIONS, parseCaseStudy, type CaseStudyContent } from "@/lib/prompts/case-study";

const KEYS = ["summary", "practice", "outcomes", "experience"] as const;
const LIMITS = { summary: [200, 300], practice: [900, 1200], outcomes: [300, 400], experience: [300, 400] } as const;
const TRIM_ORDER = ["practice", "experience", "outcomes", "summary"] as const;
const sentences = (text: string) => text.match(/【待补实测数据：[^】]*】|(?:(?!【待补实测数据：)[^。！？；\n])+[。！？；]*\n*|\n+/g) ?? [];

export function countChineseChars(text: string) {
  return (text.replace(/【待补实测数据：[^】]*】|!\[[^\]]*\]\([^\n]*\)|!\[\[[^\]]*\]\]|[【\[](?:图片|插图|配图)[^】\]]*[】\]]/g, "").match(/\p{Script=Han}/gu) ?? []).length;
}

// MUST TRIM ONCE: 按指定顺序移除句尾，守住各段下限；不能合规的草稿留给教师修订。
// 📐 CONTRACT: 不截断句子或触发模型重试；🔗 RELATED: CASE_SECTIONS 和 Word 预览。
// ⛔ DO NOT REVERT: 字数不足或超限用 warnings 告知。
export function validateAndTrimWordCounts(input: CaseStudyContent) {
  const content = { ...input };
  const counts = () => ({
    summary: countChineseChars(content.summary), practice: countChineseChars(content.practice),
    outcomes: countChineseChars(content.outcomes), experience: countChineseChars(content.experience),
  });
  let total = Object.values(counts()).reduce((a, b) => a + b, 0);
  const initialTotal = total;
  for (const key of TRIM_ORDER) {
    const [min, max] = LIMITS[key];
    const length = countChineseChars(content[key]);
    const preferredMax = key === "practice" && initialTotal > 2000 ? 1050 : max;
    const target = Math.max(min, Math.min(preferredMax, length - Math.max(0, total - 2000)));
    if (target >= length) continue;
    const parts = sentences(content[key]);
    let size = length;
    while (parts.length > 1 && size > target) {
      const last = countChineseChars(parts[parts.length - 1]);
      if (size - last < min) break;
      parts.pop();
      size -= last;
    }
    content[key] = parts.join("").trim();
    total -= length - size;
  }
  const wordCount = { ...counts(), total: Object.values(counts()).reduce((a, b) => a + b, 0) };
  const warnings = KEYS.flatMap((key) => {
    const [min, max] = LIMITS[key];
    return wordCount[key] < min || wordCount[key] > max ? [`${CASE_SECTIONS[key]}为 ${wordCount[key]} 字，要求 ${min}–${max} 字。`] : [];
  });
  if (wordCount.total < 1750 || wordCount.total > 2000) warnings.push(`全文为 ${wordCount.total} 字，目标 1750–2000 字。`);
  return { content, wordCount, warnings };
}

export function sanitizeNames<T>(value: T, names: string[]): { value: T; matched: boolean } {
  const ordered = [...new Set(names.map((name) => name?.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!ordered.length) return { value, matched: false };
  const pattern = new RegExp(ordered.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  let matched = false;
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return item.replace(pattern, () => { matched = true; return "某同学"; });
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    return item;
  };
  return { value: visit(value) as T, matched };
}

type QuizStats = { completionRate: number; avgScorePercent?: number; passRate?: number };
type ConversationStats = { totalConversations: number; totalMessages: number };

// MUST PROJECT AGGREGATES EXPLICITLY: 论文采集器带原始记录，探究摘要也含学生结论采样。
// 📐 CONTRACT: 探究用结构化计数重写摘要，报告仅保留数字；🔗 RELATED: stats-aggregator.ts。
// ⛔ DO NOT REVERT: 不转发任何原始采样、报告正文、题目答案或对话。
export function buildCaseStudySnapshot(raw: ResearchDataSnapshot, names: string[] = []) {
  return sanitizeNames({
    scope: { taskTitle: raw.scope.taskTitles[0] || "", studentCount: raw.scope.studentCount, classNames: raw.scope.classNames },
    quiz: raw.quizData?.perQuizStats.filter((q) => q.totalSubmissions > 0).slice(0, 20).map((q): QuizStats => ({
      completionRate: q.completionRate, avgScorePercent: q.avgScorePercent, passRate: q.passRate,
    })) ?? [],
    conversation: raw.conversationData ? {
      totalConversations: raw.conversationData.totalConversations, totalMessages: raw.conversationData.totalMessages,
    } : undefined,
    exploration: { summaryText: raw.explorationData?.totalActivities
      ? `已启用 ${raw.explorationData.totalActivities} 项探究活动` : "" },
    reports: raw.quizReports?.slice(0, 20).map(({ stats }) => ({
      participantCount: stats.participantCount, completionRate: stats.completionRate,
      avgScorePercent: stats.avgScorePercent, passRate: stats.passRate,
    })) ?? [],
  }, names).value;
}

type Snapshot = ReturnType<typeof buildCaseStudySnapshot>;

export function applyCaseEvidence(content: CaseStudyContent, snapshot: Snapshot) {
  const evidence: string[] = [];
  const gaps = [...content.dataGaps];
  const missing = (label: string) => { gaps.push(label); };
  if (snapshot.scope.studentCount > 0) evidence.push(`课堂统计范围覆盖 ${snapshot.scope.studentCount} 名学生。`);
  else missing("课堂覆盖人数");
  snapshot.quiz.forEach(({ completionRate, avgScorePercent, passRate }, index) => {
    const metrics = [[completionRate, "提交记录完整率"], [avgScorePercent, "平均得分率"], [passRate, "及格率"]] as const;
    const usable = metrics.flatMap(([value, label]) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? [`${label} ${value}%`] : []);
    if (usable.length) evidence.push(`第${index + 1}项作业的${usable.join("、")}。`);
  });
  if (!snapshot.quiz.length) missing("作业完成与评分数据");
  const conversation = snapshot.conversation;
  if (conversation && conversation.totalConversations > 0) {
    evidence.push(`该课堂预设活动累计 ${conversation.totalConversations} 段对话、${conversation.totalMessages} 条消息。`);
  } else missing("课堂对话统计");
  const prose = sentences(content.outcomes).filter((sentence) => {
    if (sentence.startsWith("【待补实测数据：")) {
      missing(sentence.slice("【待补实测数据：".length, -1));
      return false;
    }
    if (/[\p{N}%％]|百分之|千分之|[零〇一二两三四五六七八九十百千万亿半]+\s*(?:名|人|次|成|倍|分|份|项|组|个|小时|分钟|秒)/u.test(sentence)) {
      missing("模型成效表述所需的实测数据");
      return false;
    }
    return true;
  }).join("").trim();
  if (snapshot.exploration.summaryText) evidence.push(snapshot.exploration.summaryText);
  else missing("探究提交数据");
  const dataGaps = [...new Set(gaps.filter(Boolean))];
  return { ...content, dataGaps, outcomes: [...evidence, ...dataGaps.map((label) => `【待补实测数据：${label}】`), prose].filter(Boolean).join("\n") };
}

export async function generateCaseStudy(args: {
  teacherId: string; taskId: string; title: string; grade?: string | null; subject?: string | null;
  classId?: string; topicHint?: string; themes: string[];
}) {
  const { teacherId, taskId, classId } = args;
  const [raw, assignments] = await Promise.all([
    collectResearchData(teacherId, [taskId], ["quiz", "quizReport", "conversation", "conversationReport", "exploration", "explorationReport"]),
    prisma.taskAssignment.findMany({ where: { taskId, ...(classId ? { classId } : {}) }, select: { classId: true, class: { select: {
      name: true, User_User_classIdToClass: { where: { role: "STUDENT" }, select: { id: true, name: true } },
    } } } }),
  ]);
  const names = [
    ...assignments.flatMap(({ class: group }) => group.User_User_classIdToClass.map((student) => student.name)),
    ...(raw.quizData?.attempts.map((item) => item.studentName) ?? []),
    ...(raw.conversationData?.conversations.map((item) => item.studentName) ?? []),
  ];
  const snapshot = buildCaseStudySnapshot(raw, names);
  snapshot.scope = sanitizeNames({
    taskTitle: args.title,
    studentCount: assignments.reduce((sum, item) => sum + item.class.User_User_classIdToClass.length, 0),
    classNames: assignments.map((item) => item.class.name),
  }, names).value;

  // MUST KEEP EVIDENCE IN SCOPE: 论文采集器按班级取对话，可能混入其他课堂；指定班级时作业也需重算。
  // 📐 CONTRACT: 只读课堂预设下的对话，保存的班级报告仅用于未指定班级时；🔗 RELATED: case-study route。
  // ⛔ DO NOT REVERT: 不把全班汇总标为指定班级数据。
  const where = { classId: { in: assignments.map((item) => item.classId) }, PresetConversation: { SubProject: { taskId } } };
  const studentIds = assignments.flatMap(({ class: group }) => group.User_User_classIdToClass.map((student) => student.id));
  const [totalConversations, totalMessages, submissions, quizzes] = await Promise.all([
    prisma.conversation.count({ where }), prisma.message.count({ where: { Conversation: where } }),
    prisma.explorationSubmission.count({ where: {
      studentId: { in: studentIds }, ExplorationActivity: { enabled: true, SubProject: { taskId } },
    } }),
    prisma.quizActivity.findMany({ where: { SubProject: { taskId } }, select: {
      passScore: true, _count: { select: { Question: true } },
      QuizAttempt: { where: { userId: { in: studentIds }, submittedAt: { not: null } }, select: {
        score: true, _count: { select: { QuestionAttempt: true } },
      } },
    } }),
  ]);
  snapshot.exploration = { summaryText: submissions > 0 ? `探究活动累计记录 ${submissions} 次提交。` : "" };
  snapshot.conversation = { totalConversations, totalMessages };
  snapshot.quiz = quizzes.filter((quiz) => quiz.QuizAttempt.length > 0).slice(0, 20).map((quiz) => {
    const done = quiz.QuizAttempt.filter((attempt) => quiz._count.Question > 0 && attempt._count.QuestionAttempt === quiz._count.Question);
    return {
      completionRate: Math.round(done.length * 100 / quiz.QuizAttempt.length),
      avgScorePercent: done.length ? Math.round(done.reduce((sum, attempt) => sum + attempt.score, 0) / done.length) : undefined,
      passRate: done.length ? Math.round(done.filter((attempt) => attempt.score >= (quiz.passScore ?? 60)).length * 100 / done.length) : undefined,
    };
  });
  if (classId) snapshot.reports = [];
  const topic = sanitizeNames(args.topicHint || args.title, names).value;
  const prompt = buildCaseStudyPrompt({ ...snapshot, ...sanitizeNames({ grade: args.grade, subject: args.subject }, names).value }, topic, args.themes);
  const { chatModel } = await createDashScopeClient("text", undefined, { noFailover: true });
  const response = await aiQueue.enqueue(() => generateText({ model: chatModel, ...prompt, maxOutputTokens: 8192, maxRetries: 0 }));
  const parsed = parseCaseStudy(response.text);
  const redacted = sanitizeNames({ ...parsed, title: parsed.title || topic }, names);
  const result = validateAndTrimWordCounts(applyCaseEvidence(redacted.value, snapshot));
  if (result.content.dataGaps.length) result.warnings.push("成果成效有待补的实测数据。");
  if (!result.content.practice.includes("模式提炼") || !result.content.practice.includes("具体做法")) {
    result.warnings.push("主要做法需要补齐“模式提炼”和“具体做法”两节。");
  }
  if (redacted.matched) result.warnings.push("检测到学生姓名，已替换为“某同学”。");
  return result;
}
