import { NextResponse } from "next/server";
import { requireTeacher } from "@/lib/api-auth";
import { inspectTeacherBackup } from "@/lib/teacher-backup-inspect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BYTES = 512 * 1024 * 1024;

// MUST VALIDATE BEFORE RESTORE: 此接口仅预检，不修改现有数据库与文件。
// 📐 CONTRACT: 恢复和预检使用相同校验，大小超限或校验失败时拒绝。
// 🔗 RELATED: src/lib/teacher-backup-inspect.ts、src/lib/teacher-safety-backup.ts。
// ⛔ DO NOT REVERT: 禁止把文件解密成功当作可恢复的证明。
export async function POST(req: Request) {
  const auth = await requireTeacher(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const contentLength = Number(req.headers.get("content-length") || 0);
    if (contentLength > MAX_BYTES + 1024 * 1024) return NextResponse.json({ error: "备份文件超过限制" }, { status: 413 });
    const form = await req.formData();
    const file = form.get("file");
    const password = form.get("password");
    if (!(file instanceof Blob) || typeof password !== "string" || !password || password.length > 256 || file.size > MAX_BYTES) return NextResponse.json({ error: "请选择备份文件并输入密码，文件最大 512 MB" }, { status: 400 });
    return NextResponse.json(await inspectTeacherBackup(Buffer.from(await file.arrayBuffer()), password));
  } catch (error) {
    console.error("[teacher-data-preview]", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "备份校验失败" }, { status: 400 });
  }
}
