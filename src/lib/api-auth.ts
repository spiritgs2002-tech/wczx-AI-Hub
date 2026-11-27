import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/lib/auth";

/**
 * 接口鉴权公共函数（教师端）
 *
 * 为什么有它：历史上每个 route 各自复制「取 token → verifyToken」，很多接口只校验了“已登录”，
 *   漏掉了“是教师”和“资源归属本人”，导致学生 token 能删改教师的对话活动（2026-11-11 体检发现）。
 * 📐 CONTRACT：新增/改造教师端接口时统一用这里的函数，不要再手写只校验登录态的代码。
 *   - requireTeacher：未登录 401，非教师 403
 *   - ownsSubProject / ownsPresetConversation：资源不存在或不属于本人一律返回 false（调用方回 404，避免泄露存在性）
 * 🔗 RELATED：src/app/api/preset-conversations/** 已改用；其余接口待逐步迁移（见体检报告）。
 */
export type TeacherAuth = { userId: string };

export async function requireTeacher(req: NextRequest | Request): Promise<TeacherAuth | NextResponse> {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return new NextResponse("未登录", { status: 401 });
  const payload = await verifyToken(token);
  if (!payload) return new NextResponse("登录已过期", { status: 401 });
  if (payload.role !== "TEACHER") return new NextResponse("无权限", { status: 403 });
  return { userId: String(payload.userId) };
}

export async function ownsSubProject(subProjectId: string, teacherId: string): Promise<boolean> {
  const sp = await prisma.subProject.findFirst({
    where: { id: subProjectId, task: { teacherId } },
    select: { id: true },
  });
  return !!sp;
}

export async function ownsPresetConversation(presetConversationId: string, teacherId: string): Promise<boolean> {
  const pc = await prisma.presetConversation.findFirst({
    where: { id: presetConversationId, SubProject: { task: { teacherId } } },
    select: { id: true },
  });
  return !!pc;
}

/**
 * QuickForm 任务归属：qf_task 由互动探究（ExplorationActivity.qfTaskId）绑定，经探究 → 项目 → 课堂归属到教师。
 * 为什么：/api/qf/records、/api/qf/count 原先只校验「已登录」，学生令牌即可读取全班提交数据（2026-11-27 审核发现）。
 * 📐 CONTRACT：不存在或不属于本人一律 false（调用方回 404）。
 * 🔗 RELATED：src/app/api/qf/records/[taskId]/route.ts、src/app/api/qf/count/[taskId]/route.ts。
 */
export async function ownsQfTask(qfTaskId: string, teacherId: string): Promise<boolean> {
  const ex = await prisma.explorationActivity.findFirst({
    where: { qfTaskId, SubProject: { task: { teacherId } } },
    select: { id: true },
  });
  return !!ex;
}
