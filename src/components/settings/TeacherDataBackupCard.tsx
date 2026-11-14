"use client";

import { useState } from "react";
import { Button, MessagePlugin } from "tdesign-react";

// MUST KEEP PASSWORD OUT OF STORAGE: 备份包含密钥与学生数据，密码只保留在本次页面输入中。
// 📐 CONTRACT: 调用教师鉴权导出接口，文件名由服务器按生成时间提供。
// 🔗 RELATED: src/app/api/teacher-data/export/route.ts、src/lib/teacher-backup-crypto.ts。
// ⛔ DO NOT REVERT: 不把密码或明文备份存入 localStorage，也不要把加密失败当成成功下载。
export default function TeacherDataBackupCard() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [importPassword, setImportPassword] = useState("");
  const [preview, setPreview] = useState<{ createdAt: string; classes: number; students: number; tasks: number; files: number } | null>(null);

  async function previewBackup() {
    if (!file || !importPassword) { MessagePlugin.warning("请选择备份文件并输入密码"); return; }
    setBusy(true); setPreview(null);
    try {
      const body = new FormData(); body.append("file", file); body.append("password", importPassword);
      const response = await fetch("/api/teacher-data/preview", { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("token") || ""}` }, body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "备份校验失败");
      setPreview(data);
    } catch (error) { MessagePlugin.error(error instanceof Error ? error.message : "备份校验失败"); }
    finally { setBusy(false); }
  }

  // MUST CONFIRM REPLACEMENT: 恢复会更换账号和全部课堂数据，须先预检并由教师确认。
  // 🔗 RELATED: src/app/api/teacher-data/restore/route.ts、src/lib/teacher-safety-backup.ts。
  // ⛔ DO NOT REVERT: 自动备份和恢复后重新登录是恢复流程的一部分。
  async function restoreBackup() {
    if (!file || !importPassword || !preview) { MessagePlugin.warning("请先选择并校验备份"); return; }
    if (!window.confirm("恢复将替换当前账号、课堂、学生数据和附件。系统会先使用本次密码在服务器自动备份当前数据；请确保其他用户已停止操作。恢复后需要使用备份中的账号重新登录。确定继续吗？")) return;
    setBusy(true);
    try {
      const body = new FormData(); body.append("file", file); body.append("password", importPassword); body.append("confirm", "restore");
      const response = await fetch("/api/teacher-data/restore", { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("token") || ""}` }, body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "恢复失败");
      localStorage.removeItem("token"); localStorage.removeItem("user");
      window.alert(`恢复完成。恢复前自动备份保存在服务器 .teacher-backups/${data.safetyBackup}，请使用备份中的账号重新登录。`);
      window.location.assign("/login");
    } catch (error) { MessagePlugin.error(error instanceof Error ? error.message : "恢复失败"); setBusy(false); }
  }

  async function exportBackup() {
    if (password.length < 8 || password.length > 256) { MessagePlugin.warning("备份密码须为 8 至 256 个字符"); return; }
    if (password !== confirmPassword) { MessagePlugin.warning("两次输入的密码不一致"); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/teacher-data/export", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token") || ""}` },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "导出失败，请重试");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const filename = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1];
      link.download = filename || `wczx-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.wczx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setPassword(""); setConfirmPassword("");
      MessagePlugin.success("加密备份已下载，请妥善保管密码");
    } catch (error) {
      MessagePlugin.error(error instanceof Error ? error.message : "导出失败");
    } finally { setBusy(false); }
  }

  return (
    <section className="bg-white rounded-xl shadow-sm border border-[var(--card-border)] px-6 py-5">
      <h2 className="font-medium text-[var(--foreground)]">教师数据加密备份</h2>
      <p className="mt-2 text-sm text-[var(--muted)]">备份包含课堂、学生数据、知识库、API 配置和上传文件。建议使用 12 位以上、难以猜测的密码，并妥善保存。</p>
      <p className="mt-1 text-sm text-[var(--muted)]">备份或恢复期间请暂停课堂、学生登录和文件上传。恢复前会自动备份当前数据。</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="设置备份密码（至少 8 位）" aria-label="备份密码" className="border border-[var(--card-border)] rounded-lg px-3 py-2 text-sm" />
        <input type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="再次输入备份密码" aria-label="确认备份密码" className="border border-[var(--card-border)] rounded-lg px-3 py-2 text-sm" />
        <Button theme="primary" loading={busy} onClick={exportBackup}>导出加密备份</Button>
      </div>
      <div className="mt-5 border-t border-[var(--card-border)] pt-4">
        <p className="text-sm font-medium">检查已有备份</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <input type="file" accept=".wczx" aria-label="选择备份文件" onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null); }} />
          <input type="password" autoComplete="off" value={importPassword} onChange={(e) => { setImportPassword(e.target.value); setPreview(null); }} placeholder="输入备份密码" aria-label="备份文件密码" className="border border-[var(--card-border)] rounded-lg px-3 py-2 text-sm" />
          <Button loading={busy} onClick={previewBackup}>校验备份</Button>
        </div>
        {preview && <div className="mt-2"><p className="text-sm">备份时间：{new Date(preview.createdAt).toLocaleString()}；班级 {preview.classes} 个、学生 {preview.students} 人、课堂 {preview.tasks} 个、上传文件 {preview.files} 个。</p><Button className="mt-3" theme="danger" loading={busy} onClick={restoreBackup}>恢复此备份</Button></div>}
      </div>
    </section>
  );
}
