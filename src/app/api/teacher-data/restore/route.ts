import { NextResponse } from "next/server";
import path from "path";
import { requireTeacher } from "@/lib/api-auth";
import { restoreTeacherBackup } from "@/lib/teacher-restore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BYTES = 512 * 1024 * 1024;

// MUST REQUIRE CONFIRMATION: 恢复会替换当前课堂、账号及附件，只有教师明确确认后才能执行。
// 📐 CONTRACT: 恢复前校验备份并自动保存当前数据，恢复成功后旧令牌失效。
// 🔗 RELATED: src/lib/teacher-restore.ts、teacher-safety-backup.ts、TeacherDataBackupCard.tsx。
// ⛔ DO NOT REVERT: 不允许未授权、未确认或未完成备份时恢复，也不直接覆盖数据库文件。
export async function POST(req: Request) {
  const auth = await requireTeacher(req);
  if (auth instanceof NextResponse) return auth;
  try {
    if (Number(req.headers.get("content-length") || 0) > MAX_BYTES + 1024 * 1024) return NextResponse.json({ error: "备份文件超过限制" }, { status: 413 });
    const form = await req.formData();
    const file = form.get("file");
    const password = form.get("password");
    if (form.get("confirm") !== "restore" || !(file instanceof Blob) || typeof password !== "string" || password.length < 8 || password.length > 256 || file.size > MAX_BYTES) return NextResponse.json({ error: "请确认恢复并提供有效的备份文件和密码" }, { status: 400 });
    const result = await restoreTeacherBackup(Buffer.from(await file.arrayBuffer()), password, auth.userId);
    return NextResponse.json({ success: true, safetyBackup: path.basename(result.backupPath) });
  } catch (error) {
    console.error("[teacher-data-restore]", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "恢复失败" }, { status: 500 });
  }
}
