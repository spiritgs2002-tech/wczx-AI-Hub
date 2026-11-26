import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// MUST KEEP ONE PROMPT FIELD ALLOWLIST: 比较、留痕、详情与回滚共用同一字段集合。
// 📐 CONTRACT: 快照只含提示词字符串或 null；🔗 RELATED: 五个保存 route 与 prompt-versions API。
// ⛔ DO NOT REVERT: 不接受结构字段、学生信息或任意模型名。
export const PROMPT_FIELDS = {
  PresetConversation: ["analysisPrompt", "classAnalysisPrompt", "systemPrompt"],
  ExplorationActivity: ["aiCompanionPrompt", "analysisPrompt", "designPrompt"],
  QuizActivity: ["analysisPrompt"],
  AnalysisTemplate: ["content"],
  LearningTask: ["analysisPrompt", "classAnalysisPrompt"],
} as const;

export type PromptModel = keyof typeof PROMPT_FIELDS;

export function isPromptModel(model: string): model is PromptModel {
  return Object.prototype.hasOwnProperty.call(PROMPT_FIELDS, model);
}

export function snapshotOf(model: string, row: Record<string, unknown>): string {
  if (!isPromptModel(model)) return "{}";
  return JSON.stringify(Object.fromEntries(PROMPT_FIELDS[model].map((key) => {
    const value = row[key];
    return [key, typeof value === "string" ? value : null];
  })));
}

export function parsePromptSnapshot(model: string, raw: string): Record<string, string | null> {
  const parsed: unknown = JSON.parse(raw);
  if (!isPromptModel(model) || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("无效的提示词快照");
  }
  const row = parsed as Record<string, unknown>;
  const snapshot: Record<string, string | null> = {};
  for (const field of PROMPT_FIELDS[model]) {
    const value = row[field];
    if (value !== null && typeof value !== "string") throw new Error("提示词快照字段无效");
    snapshot[field] = value;
  }
  return snapshot;
}

type RecordVersionParams = {
  teacherId: string;
  targetModel: string;
  targetId: string;
  label?: string | null;
  before: string;
  after: string;
  changeSource?: "edit" | "restore";
};

async function appendVersion(db: Prisma.TransactionClient, params: RecordVersionParams) {
  const { teacherId, targetModel, targetId, label, before, after, changeSource = "edit" } = params;
  if (!teacherId || !isPromptModel(targetModel) || before === after) return;
  const oldSnapshot = JSON.stringify(parsePromptSnapshot(targetModel, before));
  const newSnapshot = JSON.stringify(parsePromptSnapshot(targetModel, after));
  if (oldSnapshot === newSnapshot) return;

  const scope = { teacherId, targetModel, targetId };
  const latest = await db.promptVersion.findFirst({
    where: scope, orderBy: { version: "desc" }, select: { version: true },
  });
  await db.promptVersion.create({
    data: { ...scope, label, oldSnapshot, newSnapshot, version: (latest?.version ?? 0) + 1, changeSource },
  });
}

// MUST PRESERVE THE EXISTING SAVE RESPONSE: 五个入口先完成业务写入，版本落库是额外操作。
// 📐 CONTRACT: 旧库尚未部署表时仍可保存；🔗 RELATED: restorePromptVersion 将回滚与回滚版本放同一事务。
// ⛔ DO NOT REVERT: 不拦截全局 Prisma 调用，也不把提示词正文写进错误日志。
export async function recordPromptVersion(params: RecordVersionParams): Promise<void> {
  if (!params.teacherId || !isPromptModel(params.targetModel) || params.before === params.after) return;
  try {
    await prisma.$transaction((tx) => appendVersion(tx, params));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "unknown";
    if (code !== "P2021") console.error("[prompt-version] 保存版本失败", code);
  }
}

export class PromptVersionNotFound extends Error {
  constructor() {
    super("版本或目标不存在");
  }
}

export function isPromptVersionTableMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "P2021";
}

// MUST RECHECK CURRENT OWNERSHIP: 即使版本属于教师本人，目标也可能已经删除或转移。
// 📐 CONTRACT: 固定 delegate 和字段映射，目标写入与新版本同事务；🔗 RELATED: restore endpoint。
// ⛔ DO NOT REVERT: 不动态索引 Prisma，也不把快照 JSON 直接传给 update。
export async function restorePromptVersion({ versionId, teacherId }: {
  versionId: string; teacherId: string;
}): Promise<{ targetModel: string; targetId: string }> {
  return prisma.$transaction(async (tx) => {
    const version = await tx.promptVersion.findFirst({ where: { id: versionId, teacherId } });
    if (!version || !isPromptModel(version.targetModel)) throw new PromptVersionNotFound();
    const { targetModel, targetId, label } = version;
    const old = parsePromptSnapshot(targetModel, version.oldSnapshot);
    const desired = JSON.stringify(old);
    const ownedTask = { teacherId };
    const activityScope = { id: targetId, SubProject: { task: ownedTask } };
    const directScope = { id: targetId, teacherId };
    let current: Record<string, unknown> | null = null;

    switch (targetModel) {
      case "PresetConversation": {
        current = await tx.presetConversation.findFirst({ where: activityScope });
        if (current && snapshotOf(targetModel, current) !== desired) {
          await tx.presetConversation.update({ where: activityScope, data: {
            systemPrompt: old.systemPrompt, analysisPrompt: old.analysisPrompt, classAnalysisPrompt: old.classAnalysisPrompt,
          } });
        }
        break;
      }
      case "ExplorationActivity": {
        current = await tx.explorationActivity.findFirst({ where: activityScope });
        if (current && snapshotOf(targetModel, current) !== desired) {
          await tx.explorationActivity.update({ where: activityScope, data: {
            designPrompt: old.designPrompt, analysisPrompt: old.analysisPrompt, aiCompanionPrompt: old.aiCompanionPrompt,
          } });
        }
        break;
      }
      case "QuizActivity": {
        current = await tx.quizActivity.findFirst({ where: activityScope });
        if (current && snapshotOf(targetModel, current) !== desired) {
          await tx.quizActivity.update({ where: activityScope, data: { analysisPrompt: old.analysisPrompt } });
        }
        break;
      }
      case "AnalysisTemplate": {
        current = await tx.analysisTemplate.findFirst({ where: directScope });
        if (current && snapshotOf(targetModel, current) !== desired) {
          if (old.content === null) throw new Error("模板正文快照无效");
          await tx.analysisTemplate.update({ where: directScope, data: { content: old.content } });
        }
        break;
      }
      case "LearningTask": {
        current = await tx.learningTask.findFirst({ where: directScope });
        if (current && snapshotOf(targetModel, current) !== desired) {
          await tx.learningTask.update({ where: directScope, data: {
            analysisPrompt: old.analysisPrompt, classAnalysisPrompt: old.classAnalysisPrompt,
          } });
        }
        break;
      }
    }
    if (!current) throw new PromptVersionNotFound();
    await appendVersion(tx, {
      teacherId, targetModel, targetId, label, changeSource: "restore",
      before: snapshotOf(targetModel, current), after: desired,
    });
    return { targetModel, targetId };
  });
}
