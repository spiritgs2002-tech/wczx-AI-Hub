import fs from "fs";
import path from "path";
import { randomBytes, timingSafeEqual } from "crypto";
import { createTeacherBackupArchive } from "./teacher-backup-create";
import { inspectTeacherBackup } from "./teacher-backup-inspect";

// MUST BACK UP BEFORE RESTORE: 自动备份未完整写入并验证时绝不能执行恢复操作。
// 📐 CONTRACT: 使用当前备份文件密码加密当前数据；备份路径仅位于服务端 .teacher-backups，文件名含 UTC 时间。
// 🔗 RELATED: src/lib/teacher-backup-create.ts、teacher-backup-crypto.ts、未来恢复入口与 .gitignore。
// ⛔ DO NOT REVERT: 不覆盖旧备份、不保存明文密码；调用恢复必须通过此函数而不能绕过。
export async function withTeacherSafetyBackup<T>(password: string, restore: (backupPath: string) => Promise<T>): Promise<{ result: T; backupPath: string }> {
  const { encrypted, createdAt } = await createTeacherBackupArchive(password);
  const dir = path.join(process.cwd(), ".teacher-backups");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error("自动备份目录不安全");
  const stamp = createdAt.replace(/[:.]/g, "-");
  const backupPath = path.join(dir, `before-restore-${stamp}-${randomBytes(6).toString("hex")}.wczx`);
  const partialPath = `${backupPath}.partial`;
  let fd: number | undefined;
  let partialCreated = false;
  let backupCreated = false;
  try {
    fd = fs.openSync(partialPath, "wx", 0o600);
    partialCreated = true;
    fs.writeFileSync(fd, encrypted);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const saved = fs.readFileSync(partialPath);
    if (saved.length !== encrypted.length || !timingSafeEqual(saved, encrypted)) throw new Error("自动备份写入校验失败");
    await inspectTeacherBackup(saved, password);
    // MUST PUBLISH ONLY VALID BACKUPS: 未完成文件带 .partial；硬链接要求目标不存在，避免覆盖旧备份。
    // 🔗 RELATED: .teacher-backups 目录和下方错误清理。
    // ⛔ DO NOT REVERT: 先发布完整文件再删除临时名，恢复失败时仍能找到自动备份。
    fs.linkSync(partialPath, backupPath);
    backupCreated = true;
    fs.unlinkSync(partialPath);
    partialCreated = false;
    // MUST PERSIST BACKUP NAME: POSIX 系统先同步目录，再开始恢复；Windows 不支持目录 fsync。
    // 🔗 RELATED: src/lib/teacher-restore.ts 中断恢复；⛔ DO NOT REVERT: 崩溃后仍需找到恢复前备份。
    if (process.platform !== "win32") {
      const dirFd = fs.openSync(dir, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (partialCreated) try { fs.unlinkSync(partialPath); } catch { /* 留待人工清理 */ }
    if (backupCreated) try { fs.unlinkSync(backupPath); } catch { /* 留待人工清理 */ }
    throw error;
  }
  // 保留自动备份，即使后续恢复失败也可供人工恢复。
  const result = await restore(backupPath);
  return { result, backupPath };
}
