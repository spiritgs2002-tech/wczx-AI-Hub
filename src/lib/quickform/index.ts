/**
 * QuickForm 服务端入口 —— 组装 SDK 与存储适配器（规范 §7）
 *
 * 业务代码一律 `import { getQfCore } from "@/lib/quickform"`，
 * 不直接 new QuickFormCore / PrismaAdapter。
 */
import { prisma } from "@/lib/prisma";
import { QuickFormCore, QfError, QfErrorCode } from "@/lib/quickform-core";
import type { QfRecord } from "@/lib/quickform-core";
import { generateRecordId } from "@/lib/quickform-core/id";
import { PrismaAdapter } from "./prisma-adapter";

let adapter: PrismaAdapter | null = null;
let core: QuickFormCore | null = null;

/** 存储适配器单例（业务层应通过 getQfCore 访问，一般不直接取 adapter） */
export function getQfAdapter(): PrismaAdapter {
  if (!adapter) adapter = new PrismaAdapter(prisma);
  return adapter;
}

/** SDK 单例（复用同一个 Prisma 连接） */
export function getQfCore(): QuickFormCore {
  if (!core) core = new QuickFormCore(getQfAdapter());
  return core;
}

/**
 * 写入一条收集数据。
 *
 * 传了 `replaceRecordId` 时走原子替换（core.replaceRecord）：删旧 + 写新在同一条
 * 事务里完成，避免「先删后写」两步之间的崩溃窗口丢答案（保持一人一条）。
 */
export async function submitQfRecord(
  taskId: string,
  data: Record<string, unknown>,
  replaceRecordId?: string | null,
  meta?: { ip?: string; studentId?: string }
): Promise<QfRecord> {
  const qfCore = getQfCore();
  if (replaceRecordId) {
    return qfCore.replaceRecord(taskId, replaceRecordId, data, meta);
  }
  return qfCore.submit(taskId, data, meta);
}

// ⚠️ GOTCHA: 单条仍走 core.replaceRecord，批量才在此用同一事务替换多条。
// 📐 CONTRACT: 输入是已清洗的扁平明细，返回顺序与入参一致；🔗 RELATED: qf-binding.ts。
// ⛔ DO NOT REVERT: 不能把删除和插入拆开，插入失败时必须保留旧记录。
export async function submitQfRecordBatch(
  taskId: string,
  rows: Array<Record<string, unknown>>,
  opts?: { replaceRecordIds?: string[]; ip?: string; studentId?: string },
): Promise<QfRecord[]> {
  if (!rows.length) return [];
  const task = await getQfAdapter().getTask(taskId);
  if (!task) throw new QfError(QfErrorCode.TASK_NOT_FOUND, `任务不存在: ${taskId}`);
  if (task.status !== "open") throw new QfError(QfErrorCode.TASK_CLOSED, `任务已关闭收集: ${task.name}`);

  const submittedAt = new Date().toISOString();
  const studentId = opts?.studentId || null;
  const records = rows.map((row) => ({
    id: generateRecordId(),
    taskId,
    dataJson: JSON.stringify({ ...row, ...(opts?.ip ? { _ip: opts.ip } : {}) }),
    studentId,
    submittedAt: new Date(submittedAt),
  }));

  await prisma.$transaction(async (tx) => {
    if (opts?.replaceRecordIds?.length) {
      await tx.qfRecord.deleteMany({ where: { taskId, id: { in: opts.replaceRecordIds } } });
    }
    await tx.qfRecord.createMany({ data: records });
  });

  return records.map(({ id, dataJson }) => ({
    recordId: id,
    taskId,
    submittedAt,
    studentId: studentId ?? undefined,
    data: { ...JSON.parse(dataJson), _record_id: id, _submitted_at: submittedAt },
  }));
}

/**
 * 从请求里取鉴权 token。
 * 上游 QC 前端统一用 `Authorization: Bearer <token>`；
 * 同时兼容 `x-auth-token`（魔搭适配线在用），避免两条线分叉。
 */
export function getAuthToken(req: {
  headers: { get(name: string): string | null };
}): string | null {
  const raw =
    req.headers.get("x-auth-token") || req.headers.get("authorization");
  if (!raw) return null;
  return raw.startsWith("Bearer ") ? raw.slice(7) : raw;
}

/** 取客户端 IP（写入记录的 _ip 保留字段） */
export function getClientIp(req: {
  headers: { get(name: string): string | null };
}): string | undefined {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || undefined;
}

export { QfError, QfErrorCode } from "@/lib/quickform-core";
