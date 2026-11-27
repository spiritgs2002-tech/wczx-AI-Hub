import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/lib/auth";

// PATCH: 切换作业生效/失效（二态：ACTIVE/INACTIVE）
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "未登录" }, { status: 401 });
    const payload = await verifyToken(token);
    if (!payload) return NextResponse.json({ error: "登录已过期" }, { status: 401 });

    const body = await req.json();
    const shouldEnable = body.enabled === true;
    const newStatus = shouldEnable ? "ACTIVE" : "INACTIVE";

    // MUST CHECK OWNERSHIP FOR BOTH DIRECTIONS: 归属校验必须在「生效/失效」两种操作之前都执行。
    // 为什么：原先只在「设为生效」时查归属，「设为失效」直接 update —— 任何登录用户（含学生）都能停用任意作业（2026-11-27 审核发现）。
    // ⛔ DO NOT REVERT：不要把归属查询挪回 if (shouldEnable) 分支内。
    const quiz = await prisma.quizActivity.findFirst({
      where: { id, SubProject: { task: { teacherId: String(payload.userId) } } },
      include: { Question: { select: { id: true } } },
    });
    if (!quiz) return NextResponse.json({ error: "作业不存在" }, { status: 404 });

    // 如果要生效，先校验题目数量
    if (shouldEnable && quiz.Question.length === 0) {
      return NextResponse.json({ error: "请先添加题目，再生效作业" }, { status: 400 });
    }

    const updated = await prisma.quizActivity.update({
      where: { id },
      data: { status: newStatus },
    });

    return NextResponse.json({ success: true, status: updated.status });
  } catch (e) {
    console.error("切换作业状态失败:", e);
    const message = e instanceof Error ? e.message : "切换失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
