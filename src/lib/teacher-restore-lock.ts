import { AsyncLocalStorage } from "async_hooks";
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

// MUST COORDINATE ALL SERVER PROCESSES: 恢复前要阻止新数据操作，并等待各进程中已经开始的操作结束。
// 📐 CONTRACT: 维护目录为全局锁；活动标记只记录进程号和随机值，不含用户数据；恢复上下文自身可继续。
// 🔗 RELATED: src/lib/prisma.ts、teacher-restore.ts、project-submit.ts、image-library.ts。
// ⛔ DO NOT REVERT: 仅依赖进程内计数会漏掉另一服务进程的写入，导致备份不完整。
type Activity = { count: number; marker?: string; releaseTimer?: ReturnType<typeof setTimeout> };
const globalStore = globalThis as typeof globalThis & { __wczxRestoreAccess?: AsyncLocalStorage<boolean>; __wczxActiveDataAccess?: Activity };
const restoreAccess = globalStore.__wczxRestoreAccess ??= new AsyncLocalStorage<boolean>();
const active = globalStore.__wczxActiveDataAccess ??= { count: 0 };
const activityDir = () => path.join(process.cwd(), ".teacher-active");
// MUST NOT TOUCH DISK ON EVERY QUERY: 原先每次数据库查询都同步「建目录 + 写标记文件 + 删标记文件」，
//   连续查询时磁盘 I/O 叠加并阻塞事件循环（2026-11-27 性能排查）。
// 现状：标记文件在空闲 MARKER_LINGER_MS 后才删除；期间的新查询直接复用，不再重复建删。
// 📐 CONTRACT: 恢复仍以「标记文件存在」判断有活跃访问；最多多等 MARKER_LINGER_MS（远小于 30 秒等待上限）。
//   已有标记时无需二次检查恢复标志：恢复开始后会等待该标记删除。
// 🔗 RELATED: waitForTrackedDataAccess（恢复端轮询标记目录）。
// ⛔ DO NOT REVERT 成「计数归零立即删文件」：那样每条查询都会产生一次建删磁盘操作。
const MARKER_LINGER_MS = 1500;
export function assertNoTeacherRestore() {
  if (!restoreAccess.getStore() && fs.existsSync(path.join(process.cwd(), ".teacher-restore"))) throw new Error("系统正在恢复数据，请稍后重试");
}
export function withTeacherRestoreAccess<T>(operation: () => Promise<T>): Promise<T> {
  return restoreAccess.run(true, operation);
}
function releaseMarker() {
  active.releaseTimer = undefined;
  if (active.count !== 0 || !active.marker) return;
  try { fs.unlinkSync(active.marker); } catch (error) { console.error("无法清理数据访问锁", error); }
  active.marker = undefined;
}
function begin(): boolean {
  if (restoreAccess.getStore()) return false;
  assertNoTeacherRestore();
  if (active.releaseTimer) { clearTimeout(active.releaseTimer); active.releaseTimer = undefined; }
  const created = !active.marker;
  if (created) {
    const dir = activityDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("数据访问锁目录不安全");
    active.marker = path.join(dir, `${process.pid}-${randomBytes(12).toString("hex")}.active`);
    fs.writeFileSync(active.marker, "", { mode: 0o600, flag: "wx" });
  }
  active.count++;
  // 新建标记时需二次检查：防止「首次检查后、标记写入前」恰好开始恢复
  if (created) {
    try { assertNoTeacherRestore(); } catch (error) { end(); throw error; }
  }
  return true;
}
function end() {
  active.count--;
  if (active.count === 0 && active.marker && !active.releaseTimer) {
    active.releaseTimer = setTimeout(releaseMarker, MARKER_LINGER_MS);
    active.releaseTimer.unref?.();
  }
}
export async function withTrackedDataAccess<T>(operation: () => Promise<T>): Promise<T> {
  const tracked = begin();
  try { return await operation(); } finally { if (tracked) end(); }
}
export function withTrackedFileAccess<T>(operation: () => T): T {
  const tracked = begin();
  try { return operation(); } finally { if (tracked) end(); }
}
export async function waitForTrackedDataAccess(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (true) {
    let remaining = 0;
    const dir = activityDir();
    if (fs.existsSync(dir)) {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("数据访问锁目录不安全");
      for (const item of fs.readdirSync(dir)) {
        // MUST IGNORE ONLY KNOWN OS METADATA: Finder/Windows 元数据不是访问标记；未知文件仍需阻止恢复。
        // 📐 CONTRACT: 只允许精确的系统文件名，不跳过其他隐藏文件。
        // 🔗 RELATED: begin() 标记命名规则与恢复期间跨进程等待。
        // ⛔ DO NOT REVERT: 忽略所有未知文件可能漏掉活跃写入，导致恢复前备份不完整。
        if (item === ".DS_Store" || item === "Thumbs.db" || item === "desktop.ini") continue;
        const match = /^(\d+)-[a-f0-9]{24}\.active$/.exec(item);
        if (!match) throw new Error("数据访问锁目录存在未知文件，已停止恢复；请联系管理员检查 .teacher-active 目录");
        const pid = Number(match[1]);
        try { process.kill(pid, 0); remaining++; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") { remaining++; continue; }
          try { fs.unlinkSync(path.join(dir, item)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        }
      }
    }
    if (!remaining) return;
    if (Date.now() >= deadline) throw new Error("仍有数据库或文件操作未完成（已等待 30 秒），请稍后重试；如持续发生，请联系管理员检查服务进程");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
