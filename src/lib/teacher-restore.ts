import { PrismaClient } from "@prisma/client";
import { randomInt, randomUUID } from "crypto";
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";
import { decryptTeacherBackup } from "./teacher-backup-crypto";
import { inspectTeacherBackup } from "./teacher-backup-inspect";
import { withTeacherSafetyBackup } from "./teacher-safety-backup";
import { waitForTrackedDataAccess, withTeacherRestoreAccess } from "./teacher-restore-lock";

const ROOT = process.cwd();
const STAGING = path.join(ROOT, ".teacher-restore");
const JOURNAL = path.join(STAGING, "journal.json");
const UPLOADS = path.join(ROOT, "uploads");
const INCOMING = path.join(STAGING, "incoming");
const PREVIOUS = path.join(STAGING, "previous");
const DATABASE = path.join(STAGING, "source.sqlite");
interface Journal { before: number; after: number; hadUploads: boolean }
const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
// MUST FLUSH STAGED DATA: 数据库事务提交前先持久化附件和日志；Windows 不支持 Node 打开目录 fsync。
// 🔗 RELATED: recoverInterruptedTeacherRestore 与 SQLite 事务标记；⛔ DO NOT REVERT: 减少断电后日志和文件不同步的风险。
function syncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeDurable(file: string, data: Buffer | string) {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
async function epoch(client: PrismaClient): Promise<number> {
  const rows = await client.$queryRawUnsafe<Array<{ user_version: bigint | number }>>("PRAGMA user_version");
  return Number(rows[0]?.user_version ?? 0);
}

// MUST RECOVER JOURNAL BEFORE SERVING: 数据库事务与文件重命名不能天然原子提交，以事务内 user_version 判定提交结果。
// 📐 CONTRACT: 未提交则还原旧目录；已提交则保留新目录；状态不明时抛错，禁止静默继续。
// 🔗 RELATED: src/instrumentation.ts 启动顺序、restoreTeacherBackup、src/lib/auth.ts 的令牌代次。
// ⛔ DO NOT REVERT: 无法根据 journal 和数据库代次确认时不得删除任何目录或继续提供服务。
export async function recoverInterruptedTeacherRestore(): Promise<void> {
  if (fs.existsSync(STAGING) && fs.existsSync(path.join(STAGING, "owner.json"))) {
    const owner = JSON.parse(fs.readFileSync(path.join(STAGING, "owner.json"), "utf8"));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("恢复暂存目录所有者无效");
    if (owner.pid !== process.pid) {
      try { process.kill(owner.pid, 0); throw new Error("另一进程正在恢复数据"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
  if (!fs.existsSync(JOURNAL)) {
    if (fs.existsSync(STAGING)) {
      const ownerFile = path.join(STAGING, "owner.json");
      if (!fs.existsSync(ownerFile)) throw new Error("恢复暂存目录状态不明，请联系管理员检查");
      const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("恢复暂存目录所有者无效");
      try { process.kill(owner.pid, 0); throw new Error("另一进程正在恢复数据"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      fs.rmSync(STAGING, { recursive: true, force: true });
    }
    return;
  }
  const journal = JSON.parse(fs.readFileSync(JOURNAL, "utf8")) as Journal;
  if (!Number.isInteger(journal.before) || !Number.isInteger(journal.after) || journal.after === journal.before || typeof journal.hadUploads !== "boolean") throw new Error("恢复日志无效，请联系管理员检查");
  const client = new PrismaClient();
  let value: number;
  try { value = await epoch(client); } finally { await client.$disconnect(); }
  if (value === journal.before) {
    if (journal.hadUploads && fs.existsSync(PREVIOUS)) {
      if (fs.existsSync(UPLOADS)) fs.rmSync(UPLOADS, { recursive: true, force: true });
      fs.renameSync(PREVIOUS, UPLOADS);
    } else if (journal.hadUploads && (!fs.existsSync(INCOMING) || !fs.existsSync(UPLOADS))) {
      throw new Error("原上传目录状态异常，已保留恢复日志供检查");
    } else if (!journal.hadUploads && !fs.existsSync(INCOMING) && fs.existsSync(UPLOADS)) {
      fs.rmSync(UPLOADS, { recursive: true, force: true });
    } else if (!journal.hadUploads && fs.existsSync(INCOMING) && fs.existsSync(UPLOADS)) {
      throw new Error("上传目录在恢复期间发生变化，已保留恢复日志供检查");
    }
  } else if (value !== journal.after) {
    throw new Error("恢复日志与数据库状态不一致，请联系管理员检查");
  } else if (!fs.existsSync(UPLOADS) || fs.existsSync(INCOMING)) {
    throw new Error("恢复后的上传目录状态异常，已保留恢复日志供检查");
  }
  syncDirectory(ROOT);
  fs.rmSync(STAGING, { recursive: true, force: true });
  syncDirectory(ROOT);
}

// MUST BACK UP AND VALIDATE FIRST: 包校验和当前数据自动备份完成前，不得写入目标数据库或替换上传目录。
// 📐 CONTRACT: 仅单教师部署；数据库在事务内全量替换，恢复前后的 epoch 不同，旧会话失效。
// 🔗 RELATED: teacher-safety-backup.ts、teacher-backup-inspect.ts、auth.ts、启动时恢复日志。
// ⛔ DO NOT REVERT: 禁止覆盖原始 SQLite 文件或跳过外键检查；恢复期间须暂停其他用户及文件写入。
export async function restoreTeacherBackup(buffer: Buffer, password: string, teacherId: string) {
  await inspectTeacherBackup(buffer, password);
  const gate = new PrismaClient();
  try {
    const teachers = await gate.user.findMany({ where: { role: "TEACHER" }, select: { id: true } });
    if (teachers.length !== 1 || teachers[0].id !== teacherId) throw new Error("完整恢复仅支持当前单教师部署");
  } finally { await gate.$disconnect(); }
  fs.mkdirSync(STAGING, { mode: 0o700 }); // 独占创建，拒绝并发恢复和未清理日志
  try { writeDurable(path.join(STAGING, "owner.json"), JSON.stringify({ pid: process.pid })); syncDirectory(ROOT); }
  catch (error) { fs.rmSync(STAGING, { recursive: true, force: true }); throw error; }
  return withTeacherRestoreAccess(async () => {
    try {
      await waitForTrackedDataAccess();
      return await withTeacherSafetyBackup(password, async () => {
    let journalWritten = false;
    const client = new PrismaClient();
    try {
      // MUST SET TIMEOUT BEFORE TRANSACTION: BEGIN 也可能等待 SQLite 锁，事务内部设置为时已晚。
      // 📐 CONTRACT: 恢复连接与常规连接保持 5000ms busy_timeout；事务依然执行外键校验。
      // 🔗 RELATED: src/lib/prisma.ts、下方交互事务；⛔ DO NOT REVERT: 短暂锁竞争不应立即失败。
      await client.$connect();
      await client.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
      const zip = new AdmZip(await decryptTeacherBackup(buffer, password));
      fs.mkdirSync(INCOMING, { mode: 0o700 });
      writeDurable(DATABASE, zip.getEntry("database.sqlite")!.getData());
      for (const entry of zip.getEntries()) {
        if (!entry.entryName.startsWith("uploads/")) continue;
        const relative = entry.entryName.slice("uploads/".length);
        const destination = path.resolve(INCOMING, ...relative.split("/"));
        if (!destination.startsWith(INCOMING + path.sep)) throw new Error("备份文件路径不安全");
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        writeDurable(destination, entry.getData());
        for (let parent = path.dirname(destination); parent.startsWith(INCOMING + path.sep); parent = path.dirname(parent)) syncDirectory(parent);
        syncDirectory(INCOMING);
      }
      const before = await epoch(client);
      let after = randomInt(1, 2147483647);
      if (after === before) after = before === 1 ? 2 : 1;
      const hadUploads = fs.existsSync(UPLOADS);
      if (hadUploads && (fs.lstatSync(UPLOADS).isSymbolicLink() || !fs.lstatSync(UPLOADS).isDirectory())) throw new Error("上传目录不安全，无法恢复");
      const temporaryJournal = path.join(STAGING, "journal.partial");
      writeDurable(temporaryJournal, JSON.stringify({ before, after, hadUploads } satisfies Journal));
      fs.renameSync(temporaryJournal, JOURNAL);
      syncDirectory(STAGING);
      journalWritten = true;
      await client.$transaction(async (tx) => {
        await tx.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
        await tx.$executeRawUnsafe("ATTACH DATABASE ? AS wczx_restore", DATABASE);
        await tx.$executeRawUnsafe("PRAGMA defer_foreign_keys = ON");
        const tables = await tx.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
        // 首个写语句取得 SQLite 写锁后才切换文件目录，保持回滚判定顺序。
        await tx.$executeRawUnsafe('UPDATE "User" SET "id" = "id" WHERE 0');
        if (hadUploads) fs.renameSync(UPLOADS, PREVIOUS);
        fs.renameSync(INCOMING, UPLOADS);
        syncDirectory(ROOT);
        syncDirectory(STAGING);
        for (const { name } of tables) await tx.$executeRawUnsafe(`DELETE FROM main.${quote(name)}`);
        for (const { name } of tables) await tx.$executeRawUnsafe(`INSERT INTO main.${quote(name)} SELECT * FROM wczx_restore.${quote(name)}`);
        const errors = await tx.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check");
        if (errors.length) throw new Error("恢复后的数据关联检查失败");
        await tx.$executeRawUnsafe(`PRAGMA user_version = ${after}`);
      }, { maxWait: 10000, timeout: 120000 });
      await client.$disconnect();
      await recoverInterruptedTeacherRestore();
      return { restored: true };
    } catch (error) {
      await client.$disconnect();
      if (journalWritten) await recoverInterruptedTeacherRestore();
      else fs.rmSync(STAGING, { recursive: true, force: true });
      throw error;
    }
      });
    } catch (error) {
      if (!fs.existsSync(JOURNAL)) fs.rmSync(STAGING, { recursive: true, force: true });
      throw error;
    }
  });
}
