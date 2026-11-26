import { prisma } from "@/lib/prisma";
import { buildFieldSummaries, computeNumberStats, isNumericValue } from "@/lib/prompts/dashboard-config";

const HEADING = "## 班级数据快照（仅聚合、匿名）";
const TRUNCATED = "（已截断）";
const MAX_FIELDS = 12;
const MAX_LENGTH = 2000;

const IDENTIFIER_KEY = /姓名|名字|昵称|学号|学籍|身份证|手机号|电话|邮箱|住址|联系方式|name|student[ _-]?(?:id|no|number)|phone|email|address|^(?:id|uid|qq|openid)$/i;

function safeLabel(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 80);
}

// MUST KEEP CLASS DATA ANONYMOUS: 伴学只需要本班统计量，不能接收个人记录或自由文本。
// 📐 CONTRACT: 无班级/无数据/查询失败返回空串；已声明选项可显示名称，其余高频项只显示匿名编号与次数。
// 🔗 RELATED: dashboard-config.ts 的 buildFieldSummaries、ai-chat/route.ts、ai-companion.ts。
// ⛔ DO NOT REVERT: 不把班级过滤改成可选查询，不直接拼接 top.value 或离群点数组。
export async function buildCompanionClassDataSummary(args: {
  qfTaskId: string;
  classId?: string | null;
}): Promise<string> {
  const { qfTaskId, classId } = args;
  if (!qfTaskId || !classId) return "";

  try {
    const students = await prisma.user.findMany({
      where: { classId, role: "STUDENT" },
      select: { id: true },
    });
    if (!students.length) return "";

    const records = await prisma.qfRecord.findMany({
      where: { taskId: qfTaskId, studentId: { in: students.map(({ id }) => id) } },
      orderBy: { submittedAt: "desc" },
      take: 500,
      select: { dataJson: true },
    });
    if (!records.length) return "";

    const parsed = records.flatMap(({ dataJson }) => {
      try {
        const data: unknown = JSON.parse(dataJson);
        if (!data || typeof data !== "object" || Array.isArray(data)) return [];
        return [{ data: Object.fromEntries(Object.entries(data).filter(([key]) =>
          !key.startsWith("_") && !IDENTIFIER_KEY.test(key.normalize("NFKC"))
        )) }];
      } catch {
        return [];
      }
    });
    const summaries = buildFieldSummaries(parsed);
    if (!summaries.length) return "";

    const declaredOptions = new Map<string, Set<string>>();
    if (summaries.some((field) => field.type !== "number")) {
      const task = await prisma.qfTask.findUnique({ where: { id: qfTaskId }, select: { fieldsJson: true } });
      try {
        const fields = JSON.parse(task?.fieldsJson ?? "[]");
        if (Array.isArray(fields)) {
          for (const field of fields) {
            if ((field?.type === "select" || field?.type === "multi" || field?.type === "multiselect" || field?.type === "checkbox") && typeof field.key === "string" && Array.isArray(field.options)) {
              declaredOptions.set(field.key, new Set(field.options.filter((value: unknown) => typeof value === "string")));
            }
          }
        }
      } catch {
        // 旧任务的字段定义无法解析时，仍可显示匿名频次和数值统计。
      }
    }

    const lines = summaries.slice(0, MAX_FIELDS).map((field) => {
      const label = safeLabel(field.name) || "未命名字段";
      if (field.type === "number") {
        const stats = [
          ["均值", field.avg], ["中位数", field.median], ["众数", field.mode],
          ["最小", field.min], ["最大", field.max], ["极差", field.range],
          ["方差", field.variance], ["标准差", field.stddev],
        ].filter(([, value]) => typeof value === "number" && Number.isFinite(value))
          .map(([name, value]) => `${name}${value}`);
        return [`- 字段「${label}」`, "数值", `提交${field.count}条`, ...stats].join("｜");
      }
      const kind = field.type === "text" ? "文本" : field.type === "multi" ? "多选" : "选项";
      const options = declaredOptions.get(field.name);
      const top = (field.top ?? []).slice(0, 3).map(({ value, count }, index) => {
        const name = options?.has(value) ? safeLabel(value) : `匿名项${index + 1}`;
        return `${name} ${count}次`;
      });
      return `- 字段「${label}」｜${kind}｜提交${field.count}条${top.length ? `｜高频：${top.join("、")}` : ""}`;
    });

    let summary = HEADING;
    let included = 0;
    for (const line of lines) {
      const remainingMarker = included + 1 < summaries.length ? TRUNCATED.length + 1 : 0;
      if (summary.length + line.length + 1 + remainingMarker > MAX_LENGTH) break;
      summary += `\n${line}`;
      included++;
    }
    if (included < summaries.length) return `${summary}\n${TRUNCATED}`;
    // MUST KEEP GROUP LABELS ANONYMOUS: 只有教师预设选项可显示原名，其他值只输出编号。
    // 📐 CONTRACT: 组内只输出聚合值；🔗 RELATED: buildFieldSummaries、声明选项读取和 2000 字截断。
    // ⛔ DO NOT REVERT: 不输出自由文本、学生记录或离群点数组。
    const numeric = summaries.filter((field) => field.type === "number").slice(0, 3);
    const groupedLines: string[] = [];
    for (const field of summaries.filter((f) => (f.type === "option" || f.type === "multi") && f.unique >= 2 && f.unique <= 8)) {
      const groups = new Map<string, typeof parsed>();
      for (const record of parsed) {
        const raw = record.data[field.name];
        const values = Array.isArray(raw) ? raw : [raw];
        for (const value of new Set(values.filter((v) => v != null && String(v).trim()).map(String))) {
          groups.set(value, [...(groups.get(value) || []), record]);
        }
      }
      let anonymous = 0;
      for (const [value, rows] of [...groups].slice(0, 8)) {
        const name = declaredOptions.get(field.name)?.has(value) ? safeLabel(value) : `匿名项${++anonymous}`;
        const values = numeric.flatMap((measure) => {
          const nums = rows.map((r) => r.data[measure.name]).filter(isNumericValue).map(Number);
          const stats = computeNumberStats(nums);
          return stats ? [`${safeLabel(measure.name)}：均值${stats.avg}、中位数${stats.median}、极差${stats.range}`] : [];
        });
        if (values.length) groupedLines.push(`- ${safeLabel(field.name)}「${name}」｜${values.join("｜")}`);
      }
    }
    if (!groupedLines.length) return summary;
    const extra = `\n## 按类别字段分组\n${groupedLines.join("\n")}`;
    if (summary.length + extra.length <= MAX_LENGTH) return summary + extra;
    return (summary + extra).slice(0, MAX_LENGTH - TRUNCATED.length) + TRUNCATED;
  } catch {
    return "";
  }
}
