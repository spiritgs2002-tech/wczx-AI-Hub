import { NextResponse } from "next/server";
import { requireTeacher } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { createTeacherBackupArchive } from "@/lib/teacher-backup-create";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MUST EXPORT ONLY SINGLE-TEACHER DATABASES: 本地系统配置和数据库是全局数据，不能在多教师环境泄露其他人的数据。
// 📐 CONTRACT: 备份包含 SQLite 一致性快照及 uploads 文件，密码只用于加密；超限或文件变化时整体失败。
// 🔗 RELATED: src/lib/teacher-backup-crypto.ts、导入和恢复流程、src/lib/project-submit.ts、src/lib/image-library.ts。
// ⛔ DO NOT REVERT: 不能用普通复制替代 SQLite 快照，不能跟随符号链接或输出未加密数据库。
export async function POST(req: Request) {
  const auth = await requireTeacher(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const { password } = await req.json();
    if (typeof password !== "string" || password.length < 8 || password.length > 256) return NextResponse.json({ error: "备份密码须为 8 至 256 个字符" }, { status: 400 });
    const teachers = await prisma.user.findMany({ where: { role: "TEACHER" }, select: { id: true } });
    if (teachers.length !== 1 || teachers[0].id !== auth.userId) return NextResponse.json({ error: "完整备份仅支持当前单教师部署" }, { status: 403 });
    const { encrypted, createdAt } = await createTeacherBackupArchive(password);
    return new Response(new Uint8Array(encrypted), { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="wczx-backup-${createdAt.replace(/[:.]/g, "-")}.wczx"` } });
  } catch (error) {
    console.error("[teacher-data-export]", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "备份失败" }, { status: 500 });
  }
}
