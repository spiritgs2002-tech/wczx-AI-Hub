import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptTeacherBackup } from "@/lib/teacher-backup-crypto";
import AdmZip from "adm-zip";
import fs from "fs";
import os from "os";
import path from "path";

const MAX_BYTES = 512 * 1024 * 1024;
// MUST VALIDATE BEFORE RESTORE: 外部备份与恢复前自动备份必须经过同一套只读校验。
// 📐 CONTRACT: 验证加密、路径、容量、CRC、SQLite 结构和数据库引用的附件。
// 🔗 RELATED: src/app/api/teacher-data/preview/route.ts、src/lib/teacher-safety-backup.ts。
// ⛔ DO NOT REVERT: 仅检查能解密会让缺附件的备份被误认为可恢复。
export async function inspectTeacherBackup(buffer: Buffer, password: string) {
  let dir: string | undefined;
  let source: PrismaClient | undefined;
  try {
    const data = await decryptTeacherBackup(buffer, password);
    const zip = new AdmZip(data);
    const entries = zip.getEntries();
    let total = 0;
    const names = new Set<string>();
    const sizes = new Map<string, number>();
    for (const entry of entries) {
      const name = entry.entryName;
      if (entry.isDirectory || names.has(name) || name.includes("\\") || name.includes(":") || name.includes("\0") || name.startsWith("/") || name.split("/").some((part: string) => !part || part === ".." || part === ".") || !(name === "manifest.json" || name === "database.sqlite" || name.startsWith("uploads/"))) throw new Error("备份包含不安全或重复的文件路径");
      names.add(name);
      total += entry.header.size;
      if (total > MAX_BYTES) throw new Error("备份内容超过 512 MB 限制");
      sizes.set(name, entry.header.size);
    }
    const manifestEntry = zip.getEntry("manifest.json");
    const databaseEntry = zip.getEntry("database.sqlite");
    if (!manifestEntry || !databaseEntry || manifestEntry.header.size > 4096) throw new Error("备份缺少必要内容");
    const manifest = JSON.parse(manifestEntry.getData().toString("utf8"));
    if (manifest.format !== "wczx-teacher-backup" || manifest.version !== 1 || typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error("备份格式或时间无效");
    // MUST READ EVERY ENTRY: ZIP 索引只包含长度；未解压时附件 CRC 损坏不会被发现。
    // 🔗 RELATED: export/route.ts 的 uploads 条目和下方数据库引用核验。
    // ⛔ DO NOT REVERT: 仅检查数据库会让损坏或缺失附件的备份误报可恢复。
    for (const entry of entries) {
      const bytes = entry.getData();
      if (bytes.length !== entry.header.size) throw new Error("备份文件内容不完整");
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wczx-preview-"));
    const filePath = path.join(dir, "database.sqlite");
    fs.writeFileSync(filePath, databaseEntry.getData(), { mode: 0o600 });
    source = new PrismaClient({ datasources: { db: { url: `file:${filePath}` } } });
    const integrity = await source.$queryRawUnsafe<Array<{ integrity_check: string }>>("PRAGMA integrity_check");
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("备份数据库完整性检查失败");
    const foreignKeys = await source.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check");
    if (foreignKeys.length) throw new Error("备份数据库关联检查失败");
    const query = "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
    const [actual, expected] = await Promise.all([source.$queryRawUnsafe<Array<{ name: string; sql: string }>>(query), prisma.$queryRawUnsafe<Array<{ name: string; sql: string }>>(query)]);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("备份数据库结构与当前版本不同，请使用相同版本恢复");
    const teachers = await source.user.count({ where: { role: "TEACHER" } });
    if (teachers !== 1) throw new Error("备份必须包含一个教师账号");
    const [images, attachments] = await Promise.all([
      source.imageAsset.findMany({ select: { groupId: true, filename: true, fileSize: true } }),
      source.projectAttachment.findMany({ select: { storedName: true, fileSize: true } }),
    ]);
    for (const image of images) {
      if (sizes.get(`uploads/image-library/${image.groupId}/${image.filename}`) !== image.fileSize) throw new Error("备份缺少数据库引用的图片或图片大小不符");
    }
    for (const attachment of attachments) {
      if (sizes.get(`uploads/student-projects/${attachment.storedName}`) !== attachment.fileSize) throw new Error("备份缺少数据库引用的项目附件或附件大小不符");
    }
    const [classes, students, tasks] = await Promise.all([source.class.count(), source.user.count({ where: { role: "STUDENT" } }), source.learningTask.count()]);
    return { createdAt: manifest.createdAt as string, classes, students, tasks, files: entries.filter((e) => !e.isDirectory && e.entryName.startsWith("uploads/")).length };
  } finally {
    if (source) await source.$disconnect();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}
