import { NextRequest, NextResponse } from "next/server";
import { requireTeacher } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { isPromptModel, isPromptVersionTableMissing } from "@/lib/prompt-version";

// MUST KEEP HISTORY LIST LIGHT: 正文由详情端点按需读取。
// 📐 CONTRACT: 列表按调用教师、时间分页；🔗 RELATED: teacher/templates/page.tsx 与 [versionId]/route.ts。
// ⛔ DO NOT REVERT: 不把快照正文放回列表。
export async function GET(req: NextRequest) {
  try {
    const auth = await requireTeacher(req);
    if (auth instanceof NextResponse) return auth;
    const query = req.nextUrl.searchParams;
    const targetModel = query.get("targetModel");
    const targetId = query.get("targetId");
    const take = Number(query.get("take") ?? 50);
    const skip = Number(query.get("skip") ?? 0);
    if ((targetModel !== null && !isPromptModel(targetModel)) ||
      !Number.isSafeInteger(take) || take < 1 || take > 100 ||
      !Number.isSafeInteger(skip) || skip < 0) {
      return NextResponse.json({ error: "提示词版本查询参数无效" }, { status: 400 });
    }

    const rows = await prisma.promptVersion.findMany({
      where: { teacherId: auth.userId, targetModel: targetModel ?? undefined, targetId: targetId ?? undefined },
      select: { id: true, targetModel: true, targetId: true, label: true, version: true, changeSource: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { version: "desc" }, { id: "desc" }],
      take: take + 1,
      skip,
    });
    return NextResponse.json({ versions: rows.slice(0, take), hasMore: rows.length > take });
  } catch (error) {
    if (isPromptVersionTableMissing(error)) {
      return NextResponse.json({ error: "提示词版本表尚未部署，请联系管理员" }, { status: 503 });
    }
    return NextResponse.json({ error: "无法读取提示词版本" }, { status: 500 });
  }
}
