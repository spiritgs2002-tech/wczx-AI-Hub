import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseMemberIds, stringifyMemberIds, validateGroupInput, type GroupInput } from "@/lib/groups/grouping";

type Context = { params: Promise<{ taskId: string }> };
const studentSelect = { id: true, name: true, studentNo: true } as const;

async function authorize(req: NextRequest, { params }: Context) {
  const token = req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  const payload = token ? await verifyToken(token) : null;
  if (!payload) return { response: NextResponse.json({ error: "请先登录" }, { status: 401 }) } as const;
  if (payload.role !== "TEACHER") return { response: NextResponse.json({ error: "仅教师可管理分组" }, { status: 403 }) } as const;
  const { taskId } = await params;
  const task = await prisma.learningTask.findUnique({
    where: { id: taskId },
    select: { teacherId: true, assignments: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { class: { select: { id: true, name: true } } } } },
  });
  if (!task) return { response: NextResponse.json({ error: "课堂不存在" }, { status: 404 }) } as const;
  if (task.teacherId !== String(payload.userId)) return { response: NextResponse.json({ error: "无权管理此课堂" }, { status: 403 }) } as const;
  return { taskId, classes: task.assignments.map(({ class: item }) => item) } as const;
}

export async function GET(req: NextRequest, context: Context) {
  try {
    const access = await authorize(req, context);
    if (access.response) return access.response;
    const requested = req.nextUrl.searchParams.get("classId");
    const selected = requested === null ? access.classes[0] : access.classes.find(({ id }) => id === requested);
    if (requested !== null && !selected) return NextResponse.json({ error: "该班级未分配此课堂" }, { status: 400 });
    if (!selected) return NextResponse.json({ classId: null, className: null, classes: [], students: [], groups: [] });
    const [students, groups] = await Promise.all([
      prisma.user.findMany({ where: { classId: selected.id, role: "STUDENT" }, select: studentSelect, orderBy: [{ studentNo: "asc" }, { name: "asc" }] }),
      prisma.taskGroup.findMany({ where: { taskId: access.taskId, classId: selected.id }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] }),
    ]);
    const studentIds = new Set(students.map(({ id }) => id));
    return NextResponse.json({
      classId: selected.id, className: selected.name, classes: access.classes, students,
      groups: groups.map(({ id, name, memberIds, tier, taskBrief }) => ({ id, name, memberIds: parseMemberIds(memberIds).filter((id) => studentIds.has(id)), tier, taskBrief })),
    });
  } catch (error) {
    return groupError(error);
  }
}

// MUST KEEP SAVED GROUP IDS: 在事务内验证班级成员和组 ID，再更新已有组、添加新组、删除移除的组。
// 📐 CONTRACT: 请求只替换指定课堂和班级的组；🔗 RELATED: GroupManagerDialog 与 grouping.ts。
// ⛔ DO NOT REVERT: 不接受跨班 ID，也不清空整表再重建。
export async function POST(req: NextRequest, context: Context) {
  try {
    const access = await authorize(req, context);
    if (access.response) return access.response;
    const body = await req.json().catch(() => null);
    if (typeof body?.classId !== "string" || !access.classes.some(({ id }) => id === body.classId)) {
      return NextResponse.json({ error: "该班级未分配此课堂" }, { status: 400 });
    }
    const scope = { taskId: access.taskId, classId: body.classId as string };
    return await prisma.$transaction(async (tx) => {
      const assignment = await tx.taskAssignment.findUnique({ where: { taskId_classId: scope }, select: { taskId: true } });
      if (!assignment) return NextResponse.json({ error: "该班级未分配此课堂" }, { status: 400 });
      const students = await tx.user.findMany({ where: { classId: scope.classId, role: "STUDENT" }, select: studentSelect });
      const validation = validateGroupInput(body.groups, new Map(students.map(({ id, name }) => [id, name])));
      if (!validation.ok) return NextResponse.json({ error: validation.errors.join("；"), errors: validation.errors }, { status: 400 });

      const groups = body.groups as GroupInput[];
      const existing = await tx.taskGroup.findMany({ where: scope, select: { id: true } });
      const existingIds = new Set(existing.map(({ id }) => id));
      if (groups.some((group) => group.id && !existingIds.has(group.id))) {
        return NextResponse.json({ error: "分组 ID 不属于当前课堂和班级，或已被删除" }, { status: 400 });
      }
      const keptIds = new Set<string>();
      for (const [sortOrder, group] of groups.entries()) {
        const data = { name: group.name.trim(), memberIds: stringifyMemberIds(group.memberIds), tier: group.tier?.trim() || null,
          taskBrief: group.taskBrief?.trim() || null, sortOrder };
        if (group.id) {
          const saved = await tx.taskGroup.upsert({ where: { id: group.id, ...scope }, update: data, create: { id: group.id, ...scope, ...data } });
          keptIds.add(saved.id);
        } else {
          const saved = await tx.taskGroup.create({ data: { ...scope, ...data } });
          keptIds.add(saved.id);
        }
      }
      const removed = [...existingIds].filter((id) => !keptIds.has(id));
      if (removed.length) await tx.taskGroup.deleteMany({ where: { ...scope, id: { in: removed } } });
      return NextResponse.json({ ok: true });
    });
  } catch (error) {
    return groupError(error);
  }
}

function groupError(error: unknown) {
  if (error && typeof error === "object" && "code" in error && error.code === "P2021") {
    return NextResponse.json({ error: "分组表尚未初始化，请联系管理员" }, { status: 503 });
  }
  console.error("[task-groups]", error);
  return NextResponse.json({ error: "分组操作失败，请稍后重试" }, { status: 500 });
}
