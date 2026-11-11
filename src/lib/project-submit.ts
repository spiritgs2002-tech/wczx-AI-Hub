import fs from "fs";
import path from "path";

// 项目提交附件存储目录
export const UPLOAD_DIR = path.join(process.cwd(), "uploads", "student-projects");

// 类别 -> 允许的 MIME / 扩展名
export const CATEGORY_ALLOWED: Record<string, { ext: string[]; mime: string[] }> = {
  TEXT: {
    ext: ["doc", "docx", "pdf", "txt"],
    mime: [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/pdf",
      "text/plain",
    ],
  },
  IMAGE: {
    ext: ["jpg", "jpeg", "png", "gif", "webp"],
    mime: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  },
  VIDEO: {
    ext: ["mp4", "webm", "mov", "avi", "mkv"],
    mime: ["video/mp4", "video/webm", "video/quicktime", "video/x-msvideo", "video/x-matroska"],
  },
};

export function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

// 清理目录/文件名中的非法字符
export function sanitizeName(name: string): string {
  return name.replace(/[/\0]/g, "_").trim() || "未命名";
}

export function getExt(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : "";
}

// 校验文件是否符合类别与大小限制；返回错误信息或 null
export function validateFile(
  file: File,
  category: string,
  sizeLimitMB: number
): string | null {
  const rule = CATEGORY_ALLOWED[category];
  if (!rule) return "未知的项目类别";

  const ext = getExt(file.name);
  const mime = file.type || "";

  // ⛔ DO NOT REVERT 为「扩展名或 MIME 任一合格即放行」：MIME 由浏览器上报、可伪造，
  //   旧写法允许把 作品.html 声称成 text/plain 上传，并以 .html 扩展名落盘（2026-11-11 体检发现）。
  // 现状：扩展名必须在白名单内（落盘扩展名与下载时的 Content-Type 都由它决定）；
  //   MIME 只做辅助判断，不单独放行，也不因浏览器上报为空而拒绝（部分 Windows 浏览器对 docx 上报空 MIME）。
  // 🔗 RELATED：下载接口 src/app/api/student-projects/[id]/attachments/[aid]/route.ts 按扩展名白名单决定 Content-Type 并带 nosniff。
  const extOk = rule.ext.includes(ext);
  void mime;
  if (!extOk) {
    return `文件类型不符合要求（类别：${category}，允许：${rule.ext.join("/")}）`;
  }

  const maxBytes = sizeLimitMB * 1024 * 1024;
  if (file.size > maxBytes) {
    return `文件大小超过限制（${file.size / 1024 / 1024 >= 1 ? (file.size / 1024 / 1024).toFixed(1) + "MB" : Math.round(file.size / 1024) + "KB"} / 上限 ${sizeLimitMB}MB）`;
  }
  if (file.size === 0) {
    return "文件内容为空";
  }
  return null;
}

// 写入文件，返回 { storedName, originalName, fileType, fileSize }
// hierarchy 可选，传入后按"课堂/项目/班级/学生_时间戳.扩展名"层级存储
export async function saveUploadedFile(
  file: File,
  hierarchy?: {
    taskName: string;
    projectName: string;
    className: string;
    studentName: string;
  }
): Promise<{ storedName: string; originalName: string; fileType: string; fileSize: number }> {
  ensureUploadDir();
  const ext = getExt(file.name);
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 10);

  let storedName: string;
  if (hierarchy) {
    const subDir = [
      sanitizeName(hierarchy.taskName),
      sanitizeName(hierarchy.projectName),
      sanitizeName(hierarchy.className),
    ].join("/");
    const fullDir = path.join(UPLOAD_DIR, subDir);
    fs.mkdirSync(fullDir, { recursive: true });
    storedName = `${subDir}/${sanitizeName(hierarchy.studentName)}_${timestamp}-${random}.${ext}`;
  } else {
    storedName = `${timestamp}-${random}.${ext}`;
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buffer);
  return {
    storedName,
    originalName: file.name,
    fileType: ext,
    fileSize: file.size,
  };
}

// 物理删除附件文件（忽略不存在）
export function deleteAttachmentFile(storedName: string) {
  if (!storedName) return;
  const p = path.join(UPLOAD_DIR, storedName);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    console.error("删除附件文件失败:", storedName, e);
  }
}
