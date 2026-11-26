import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { autoAssignGroups, DEFAULT_TIERS, type GroupStudent } from "@/lib/groups/grouping";

// MUST KEEP AUTO GROUPS READ ONLY: 自动分组供教师预览，成员和计分只查本课堂本班。
// 📐 CONTRACT: 预览不生成持久 ID；🔗 RELATED: groups/route.ts 与 GroupManagerDialog。
// ⛔ DO NOT REVERT: 不选取答卷或其他个人字段，也不在预览中写库。
export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    const payload = token ? await verifyToken(token) : null;
    if (!payload) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    if (payload.role !== "TEACHER") return NextResponse.json({ error: "仅教师可管理分组" }, { status: 403 });
    const { taskId } = await params;
    const task = await prisma.learningTask.findUnique({ where: { id: taskId }, select: { teacherId: true } });
    if (!task) return NextResponse.json({ error: "课堂不存在" }, { status: 404 });
    if (task.teacherId !== String(payload.userId)) return NextResponse.json({ error: "无权管理此课堂" }, { status: 403 });

    const { classId, mode, groupCount, tierLabels = DEFAULT_TIERS } = await req.json().catch(() => ({})) ?? {};
    if (typeof classId !== "string" || !classId || !["BALANCED", "BY_NO", "BY_SCORE"].includes(mode) ||
      !Number.isInteger(groupCount) || groupCount < 2 || groupCount > 30 ||
      !Array.isArray(tierLabels) || tierLabels.length < 1 || tierLabels.length > 30 ||
      tierLabels.some((label: unknown) => typeof label !== "string" || !label.trim() || label.length > 20)) {
      return NextResponse.json({ error: "分组参数无效，自动分组数量须为 2–30" }, { status: 400 });
    }
    const assignment = await prisma.taskAssignment.findUnique({ where: { taskId_classId: { taskId, classId } }, select: { taskId: true } });
    if (!assignment) return NextResponse.json({ error: "该班级未分配此课堂" }, { status: 400 });
    let students: GroupStudent[] = await prisma.user.findMany({ where: { classId, role: "STUDENT" }, select: { id: true, name: true, studentNo: true } });

    if (mode === "BY_SCORE" && students.length) {
      const attempts = await prisma.quizAttempt.findMany({
        where: { QuizActivity: { SubProject: { taskId } }, User: { classId, role: "STUDENT" }, submittedAt: { not: null } },
        orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
        select: { userId: true, totalScore: true, maxTotalScore: true, quizActivityId: true },
      });
      const questionTotals = new Map<string, number>();
      const ratios = new Map<string, number>();
      for (const attempt of attempts) {
        if (ratios.has(attempt.userId)) continue;
        let max = attempt.maxTotalScore ?? 0;
        if (max <= 0) {
          if (!questionTotals.has(attempt.quizActivityId)) {
            const { _sum } = await prisma.question.aggregate({ where: { quizActivityId: attempt.quizActivityId }, _sum: { score: true } });
            questionTotals.set(attempt.quizActivityId, _sum.score ?? 0);
          }
          max = questionTotals.get(attempt.quizActivityId)!;
        }
        ratios.set(attempt.userId, max > 0 && attempt.totalScore != null ? attempt.totalScore / max : 0.5);
      }
      students = students.map((student) => ({ ...student, scoreRatio: ratios.get(student.id) }));
    }

    const groups = autoAssignGroups(students, { mode, groupCount, tierLabels: tierLabels.map((label: string) => label.trim()) });
    return NextResponse.json({ groups, studentCount: students.length, unassigned: [] });
  } catch (error) {
    console.error("[task-groups-auto]", error);
    return NextResponse.json({ error: "生成分组预览失败，请稍后重试" }, { status: 500 });
  }
}
