import { NextRequest, NextResponse } from "next/server";
import { requireTeacher } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { isPromptVersionTableMissing, parsePromptSnapshot } from "@/lib/prompt-version";

// MUST SCOPE SNAPSHOT READS: 完整提示词仅通过本教师的版本 ID 按需读取。
// 📐 CONTRACT: 不存在与非本人统一 404；🔗 RELATED: prompt-versions 列表与回滚接口。
// ⛔ DO NOT REVERT: 不按单独 ID 查完再返回未经重新裁剪的快照。
export async function GET(req: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  try {
    const auth = await requireTeacher(req);
    if (auth instanceof NextResponse) return auth;
    const { versionId } = await params;
    const version = await prisma.promptVersion.findFirst({
      where: { id: versionId, teacherId: auth.userId },
      select: { targetModel: true, oldSnapshot: true, newSnapshot: true },
    });
    if (!version) return NextResponse.json({ error: "提示词版本不存在" }, { status: 404 });
    return NextResponse.json({
      oldSnapshot: parsePromptSnapshot(version.targetModel, version.oldSnapshot),
      newSnapshot: parsePromptSnapshot(version.targetModel, version.newSnapshot),
    });
  } catch (error) {
    if (isPromptVersionTableMissing(error)) {
      return NextResponse.json({ error: "提示词版本表尚未部署，请联系管理员" }, { status: 503 });
    }
    return NextResponse.json({ error: "无法读取提示词快照" }, { status: 500 });
  }
}
