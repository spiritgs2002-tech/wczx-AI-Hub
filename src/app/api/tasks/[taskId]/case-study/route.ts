import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateCaseStudy } from "@/lib/case-study/case-study-generator";
import { generateCaseStudyDocx } from "@/lib/case-study/case-study-docx";
import { CASE_THEMES, DEFAULT_CASE_THEMES } from "@/lib/prompts/case-study";
import { classifyGenError } from "@/lib/research/error-classifier";

export const runtime = "nodejs";

// MUST AUTHORIZE BEFORE COLLECTING: 案例使用班级聚合，只有课堂所属教师可以生成。
// 📐 CONTRACT: 先查权限和分配班级，再生成；🔗 RELATED: case-study-generator.ts 与教师课堂弹窗。
// ⛔ DO NOT REVERT: 不接受任意班级 ID，生成结果只写入本次响应。
export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    const payload = token ? await verifyToken(token) : null;
    if (!payload) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (payload.role !== "TEACHER") return NextResponse.json({ error: "仅教师可生成案例" }, { status: 403 });
    const { taskId } = await params;
    const task = await prisma.learningTask.findUnique({
      where: { id: taskId }, select: { teacherId: true, title: true, grade: true, subject: true },
    });
    if (!task) return NextResponse.json({ error: "课堂不存在" }, { status: 404 });
    if (task.teacherId !== String(payload.userId)) return NextResponse.json({ error: "无权操作该课堂" }, { status: 403 });

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      (body.classId !== undefined && (typeof body.classId !== "string" || !body.classId.trim())) ||
      (body.topicHint !== undefined && typeof body.topicHint !== "string") ||
      (body.themes !== undefined && (!Array.isArray(body.themes) || !body.themes.length ||
        body.themes.some((theme: unknown) => typeof theme !== "string" || !Object.hasOwn(CASE_THEMES, theme))))) {
      return NextResponse.json({ error: "案例生成参数无效" }, { status: 400 });
    }
    const classId = body.classId?.trim() as string | undefined;
    if (classId && !await prisma.taskAssignment.findUnique({ where: { taskId_classId: { taskId, classId } }, select: { taskId: true } })) {
      return NextResponse.json({ error: "该班级未分配此课堂" }, { status: 403 });
    }
    const themes = [...new Set<keyof typeof CASE_THEMES>(body.themes ?? DEFAULT_CASE_THEMES)];
    const themeLabels = themes.map((theme) => CASE_THEMES[theme]);
    const { content, wordCount, warnings } = await generateCaseStudy({
      taskId, teacherId: task.teacherId, title: task.title, grade: task.grade, subject: task.subject,
      classId, themes: themeLabels, topicHint: body.topicHint?.trim().slice(0, 120),
    });
    const { title, summary, practice, outcomes, experience, framework, dataGaps } = content;
    const docx = await generateCaseStudyDocx(content, themeLabels, warnings);
    const safeName = task.title.replace(/[\\/:*?"<>|\r\n\t\s·•,，。、？！：；…—–""''‘’《》〈〉【】（）()\[\]]+/g, "_")
      .replace(/^_+|_+$/g, "").slice(0, 30) || "课堂";
    return NextResponse.json({
      title, themes, sections: { summary, practice, outcomes, experience }, framework, wordCount,
      warnings, dataGaps, docxBase64: docx.toString("base64"), filename: `${safeName}_AI应用案例.docx`,
    });
  } catch (error) {
    const { kind, hint } = classifyGenError(error);
    const detail = kind === "PARSE" ? "AI 返回的案例格式无效，请重新生成。" :
      kind === "UNKNOWN" ? "案例生成失败，请稍后重试。" : hint;
    return NextResponse.json({ kind, error: detail }, { status: 500 });
  }
}
