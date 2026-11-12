import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireTeacher, ownsSubProject } from "@/lib/api-auth";

// POST /api/project-submissions/reorder
// Body: { submissionId: string; direction: "up" | "down"; subProjectId: string }
export async function POST(req: NextRequest) {
  try {
    const auth = await requireTeacher(req);
    if (auth instanceof NextResponse) return auth;

    const { submissionId, direction, subProjectId } = await req.json();
    if (!subProjectId) return new NextResponse("缺少 subProjectId", { status: 400 });
    // 归属校验（⛔ DO NOT REMOVE）：子项目必须属于当前教师，否则任何登录用户（含学生）都能改别人课堂的活动顺序
    if (!(await ownsSubProject(subProjectId, auth.userId))) {
      return new NextResponse("子项目不存在", { status: 404 });
    }

    const items = await prisma.projectSubmission.findMany({
      where: { subProjectId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, sortOrder: true },
    });

    const idx = items.findIndex((i) => i.id === submissionId);
    if (idx === -1) return new NextResponse("未找到项目提交", { status: 404 });

    const targetIdx = direction === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= items.length) {
      return NextResponse.json({ success: true });
    }
    const cur = items[idx];
    const target = items[targetIdx];

    await prisma.$transaction([
      prisma.projectSubmission.update({ where: { id: submissionId }, data: { sortOrder: target.sortOrder } }),
      prisma.projectSubmission.update({ where: { id: target.id }, data: { sortOrder: cur.sortOrder } }),
    ]);

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error(e);
    return new NextResponse("排序失败", { status: 500 });
  }
}
