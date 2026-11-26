export type GroupMode = "BALANCED" | "BY_NO" | "BY_SCORE";
export type GroupStudent = { id: string; name: string; studentNo: string | null; scoreRatio?: number | null };
export type GroupInput = { id?: string; name: string; memberIds: string[]; tier?: string | null; taskBrief?: string | null };
export const DEFAULT_TIERS = ["基础层", "进阶层", "挑战层"];

const collator = new Intl.Collator("zh-CN", { numeric: true });
const byNumber = (a: GroupStudent, b: GroupStudent) =>
  (a.studentNo && b.studentNo ? collator.compare(a.studentNo, b.studentNo) : Number(!a.studentNo) - Number(!b.studentNo)) ||
  collator.compare(a.name, b.name) || a.id.localeCompare(b.id);

function split<T>(items: T[], count: number): T[][] {
  const base = Math.floor(items.length / count);
  const extra = items.length % count;
  let start = 0;
  return Array.from({ length: count }, (_, index) => {
    const end = start + base + Number(index < extra);
    const part = items.slice(start, end);
    start = end;
    return part;
  });
}

// MUST KEEP PREVIEW DETERMINISTIC: 均分与分层不依赖随机数，按学号或最近得分排序。
// 📐 CONTRACT: 得分缺失进入中间层，输出恰好 groupCount 组；🔗 RELATED: groups/auto/route.ts。
// ⛔ DO NOT REVERT: 不能把无作业记录当成低分。
export function autoAssignGroups(students: GroupStudent[], options: { mode: GroupMode; groupCount: number; tierLabels?: string[] }): GroupInput[] {
  const { mode, groupCount, tierLabels = DEFAULT_TIERS } = options;
  const ordered = [...students].sort(byNumber);
  const groups: GroupInput[] = Array.from({ length: groupCount }, (_, index) => ({
    name: `第${index + 1}组`, memberIds: [], taskBrief: "",
  }));
  if (mode === "BALANCED") {
    ordered.forEach(({ id }, index) => {
      const offset = index % groupCount;
      const slot = Math.floor(index / groupCount) % 2 ? groupCount - offset - 1 : offset;
      groups[slot].memberIds.push(id);
    });
  } else if (mode === "BY_NO") {
    split(ordered, groupCount).forEach((part, index) => { groups[index].memberIds = part.map(({ id }) => id); });
  } else {
    const layerCount = Math.min(groupCount, tierLabels.length);
    const graded = ordered.filter((student) => Number.isFinite(student.scoreRatio));
    graded.sort((a, b) => b.scoreRatio! - a.scoreRatio! || byNumber(a, b));
    const layers = split(graded, layerCount);
    layers[Math.floor(layerCount / 2)].push(...ordered.filter((student) => !Number.isFinite(student.scoreRatio)));
    let cursor = 0;
    for (const [index, layer] of layers.entries()) {
      const slots = Math.floor(groupCount / layerCount) + Number(index < groupCount % layerCount);
      const labelIndex = layerCount === 1 ? 0 : Math.round((layerCount - 1 - index) * (tierLabels.length - 1) / (layerCount - 1));
      for (const part of split(layer.sort(byNumber), slots)) {
        groups[cursor].tier = tierLabels[labelIndex];
        groups[cursor].memberIds = part.map(({ id }) => id);
        cursor++;
      }
    }
  }
  return groups;
}

export function parseMemberIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? [...new Set(parsed.filter((id): id is string => typeof id === "string" && !!id))] : [];
  } catch {
    return [];
  }
}

export function stringifyMemberIds(ids: string[]): string {
  return JSON.stringify([...new Set(ids)]);
}

export function validateGroupInput(groups: unknown, studentIds: ReadonlyMap<string, string> | ReadonlySet<string>) {
  const errors: string[] = [];
  const names = new Set<string>();
  const groupIds = new Set<string>();
  const members = new Set<string>();
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > 30) return { ok: false, errors: ["组数必须为 1–30"] };
  groups.forEach((group, index) => {
    const label = `第${index + 1}组`;
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      errors.push(`${label}数据无效`);
      return;
    }
    if (group.id !== undefined) {
      if (typeof group.id !== "string" || !group.id || groupIds.has(group.id)) errors.push(`${label} ID 无效或重复`);
      else groupIds.add(group.id);
    }
    const name = typeof group.name === "string" ? group.name.trim() : "";
    const normalized = name.normalize("NFKC").toLowerCase();
    if (!name || name.length > 40) errors.push(`${label}组名必填且不超过 40 字`);
    else if (names.has(normalized)) errors.push(`组名「${name}」重复`);
    names.add(normalized);
    for (const [key, limit, title] of [["tier", 20, "层级"], ["taskBrief", 1000, "任务要求"]] as const) {
      if (group[key] != null && (typeof group[key] !== "string" || group[key].length > limit)) errors.push(`${label}${title}不能超过 ${limit} 字`);
    }
    if (!Array.isArray(group.memberIds)) {
      errors.push(`${label}成员格式无效`);
      return;
    }
    for (const id of new Set(group.memberIds)) {
      if (typeof id !== "string" || !studentIds.has(id)) errors.push(`${label}含非本班学生`);
      else if (members.has(id)) {
        const student = "get" in studentIds ? studentIds.get(id) : id;
        errors.push(`学生「${student}」同时出现在多个组`);
      } else members.add(id);
    }
  });
  return { ok: errors.length === 0, errors };
}

export function findMyGroup<T extends { sortOrder: number; memberIds: string }>(groups: T[], userId: string): T | null {
  let found: T | null = null;
  for (const group of groups) {
    if ((!found || group.sortOrder < found.sortOrder) && parseMemberIds(group.memberIds).includes(userId)) found = group;
  }
  return found;
}
