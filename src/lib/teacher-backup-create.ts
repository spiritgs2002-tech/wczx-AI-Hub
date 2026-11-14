import { prisma } from "@/lib/prisma";
import { encryptTeacherBackup } from "@/lib/teacher-backup-crypto";
import AdmZip from "adm-zip";
import fs from "fs";
import os from "os";
import path from "path";

const MAX_BYTES = 512 * 1024 * 1024;

// MUST SHARE SNAPSHOT FORMAT: 手动导出与恢复前自动备份必须使用同一套加密和附件规则。
// 📐 CONTRACT: 使用 SQLite 一致性快照，打包上传文件，失败时删除临时文件并抛错。
// 🔗 RELATED: src/app/api/teacher-data/export/route.ts、src/lib/teacher-safety-backup.ts、teacher-data/preview/route.ts。
// ⛔ DO NOT REVERT: 不得复制正在使用的数据库文件，也不得跟随上传目录中的符号链接。
export async function createTeacherBackupArchive(password: string): Promise<{ encrypted: Buffer; createdAt: string }> {
  if (password.length < 8 || password.length > 256) throw new Error("备份密码须为 8 至 256 个字符");
  let tempDir: string | undefined;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wczx-export-"));
    const snapshot = path.join(tempDir, "data.db");
    await prisma.$executeRawUnsafe("VACUUM INTO ?", snapshot);
    fs.chmodSync(snapshot, 0o600);
    const zip = new AdmZip();
    const db = fs.readFileSync(snapshot);
    let total = db.length;
    zip.addFile("database.sqlite", db);
    const root = path.join(process.cwd(), "uploads");
    const addDirectory = (directory: string, relative: string) => {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, item.name);
        const entry = relative ? `${relative}/${item.name}` : item.name;
        if (item.name.includes("\\") || item.name.includes(":")) throw new Error("上传文件名包含不支持的字符，无法安全备份");
        if (item.isSymbolicLink()) throw new Error("上传目录包含符号链接，无法安全备份");
        if (item.isDirectory()) { addDirectory(absolute, entry); continue; }
        if (!item.isFile()) throw new Error("上传目录包含不支持的文件类型");
        const before = fs.statSync(absolute);
        total += before.size;
        if (total > MAX_BYTES) throw new Error("备份数据超过 512 MB，请联系管理员处理");
        const data = fs.readFileSync(absolute);
        const after = fs.statSync(absolute);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || data.length !== before.size) throw new Error("备份期间文件发生变化，请稍后重试");
        zip.addFile(`uploads/${entry}`, data);
      }
    };
    if (total > MAX_BYTES) throw new Error("备份数据超过 512 MB，请联系管理员处理");
    if (fs.existsSync(root)) {
      if (fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory()) throw new Error("上传目录不是普通目录，无法安全备份");
      addDirectory(root, "");
    }
    const createdAt = new Date().toISOString();
    zip.addFile("manifest.json", Buffer.from(JSON.stringify({ format: "wczx-teacher-backup", version: 1, createdAt }), "utf8"));
    const encrypted = await encryptTeacherBackup(zip.toBuffer(), password);
    return { encrypted, createdAt };
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
