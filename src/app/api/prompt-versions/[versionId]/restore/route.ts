import { NextRequest, NextResponse } from "next/server";
import { requireTeacher } from "@/lib/api-auth";
import { isPromptVersionTableMissing, PromptVersionNotFound, restorePromptVersion } from "@/lib/prompt-version";

// MUST KEEP RESTORE AUTHORIZED: 工具在事务内验证版本与目标的归属。
// 📐 CONTRACT: 回滚到所选变更前，找不到或无权统一 404；🔗 RELATED: prompt-version.ts。
// ⛔ DO NOT REVERT: 不从请求体接收字段和值。
export async function POST(req: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  try {
    const auth = await requireTeacher(req);
    if (auth instanceof NextResponse) return auth;
    const { versionId } = await params;
    return NextResponse.json(await restorePromptVersion({ versionId, teacherId: auth.userId }));
  } catch (error) {
    if (error instanceof PromptVersionNotFound) {
      return NextResponse.json({ error: "版本或目标不存在" }, { status: 404 });
    }
    if (isPromptVersionTableMissing(error)) {
      return NextResponse.json({ error: "提示词版本表尚未部署，请联系管理员" }, { status: 503 });
    }
    return NextResponse.json({ error: "回滚失败，请稍后重试" }, { status: 500 });
  }
}
