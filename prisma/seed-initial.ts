import type { Prisma } from "@prisma/client";
import { randomInt } from "crypto";

// MUST INITIALIZE ATOMICALLY: 新教师首次注册和开发初始化共用相同课堂；已有班级时保留全部用户数据。
// 📐 CONTRACT: 一班十人，邀请码 1234 开放注册；四种活动挂在同一个已分配的课堂中。
// 🔗 RELATED: src/app/api/auth/register/route.ts、prisma/seed-full.ts、src/app/api/auth/student-login/route.ts。
// ⛔ DO NOT REVERT: 不用邀请码 upsert 覆盖别人的班级，不虚构学生提交；冲突时事务失败并保留现有数据。
export async function seedInitialClass(tx: Prisma.TransactionClient, teacherId: string) {
  if (await tx.class.count({ where: { teacherId } })) return false;
  if (await tx.class.findUnique({ where: { inviteCode: "1234" } })) {
    throw new Error("初始化邀请码 1234 已被其他班级使用");
  }
  const cls = await tx.class.create({ data: { teacherId, name: "七1班", inviteCode: "1234", openInviteCode: true, isCurrent: true, status: "ACTIVE" } });
  const names = ["林子涵", "周明远", "陈雨桐", "许嘉宁", "何思源", "郑书瑶", "方宇辰", "沈欣然", "唐语安", "罗俊熙", "叶知夏", "陆文博", "苏沐晴", "程一诺", "白思齐", "杜若溪", "邱景行", "宋佳乐", "江书涵", "高子墨"];
  for (let i = names.length - 1; i > 0; i--) { const j = randomInt(i + 1); [names[i], names[j]] = [names[j], names[i]]; }
  await tx.user.createMany({ data: names.slice(0, 10).map((name, i) => ({ name, studentNo: String(i + 1).padStart(2, "0"), role: "STUDENT", classId: cls.id, password: null })) });
  const task = await tx.learningTask.create({ data: { teacherId, title: "一元一次方程", description: "通过对话、探究、项目和作业学习一元一次方程", grade: "七年级", subject: "数学", objectives: "理解一元一次方程，掌握解法并应用于实际问题。", requirements: "按顺序完成课堂活动。", status: "ENABLED", updatedAt: new Date() } });
  const sub = await tx.subProject.create({ data: { taskId: task.id, title: "一元一次方程学习活动", description: "探索方程并解决生活问题", objectives: "理解方程、解释解题过程并应用", requirements: "完成四项活动", sortOrder: 1, enabled: true } });
  await tx.taskAssignment.create({ data: { taskId: task.id, classId: cls.id } });
  await tx.presetConversation.create({ data: { subProjectId: sub.id, title: "什么是方程？", description: "从生活问题理解方程", systemPrompt: "你是一位耐心的数学教师，使用问题和提示引导学生理解方程，不直接代替学生思考。", enabled: true, sortOrder: 1 } });
  await tx.explorationActivity.create({ data: { subProjectId: sub.id, title: "探索方程的解", description: "尝试不同的数值，观察等式何时成立。", sortOrder: 2, enabled: true, htmlContent: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>探索方程</title><body><h2>探索 2x + 3 = 11</h2><p>输入一个数，观察等式两边是否相等。</p><label>x = <input id="x" type="number"></label><button onclick="check()">验证</button><p id="result"></p><script>function check(){var v=document.getElementById('x').value;document.getElementById('result').textContent=v===''?'请先输入数字':('左边 = '+(2*Number(v)+3)+'，右边 = 11');}</script></body></html>` } });
  await tx.projectSubmission.create({ data: { subProjectId: sub.id, title: "用方程解决生活问题", description: "写出一个生活中的问题，列出方程并解释解题过程。", category: "TEXT", enabled: true, sortOrder: 3 } });
  await tx.quizActivity.create({ data: { subProjectId: sub.id, title: "方程基础练习", description: "检验方程的理解与运用", status: "PUBLISHED", sortOrder: 4, updatedAt: new Date(), Question: { create: [ { type: "SINGLE_CHOICE", content: "方程 2x + 3 = 11 的解是？", options: JSON.stringify({ A: "3", B: "4", C: "5", D: "6" }), answer: "B", score: 50, difficulty: "EASY", order: 1, explanation: "两边减去 3，再除以 2，得到 x = 4。" }, { type: "FILL_BLANK", content: "若 3x - 7 = 8，则 x = ___", answer: "5", score: 50, difficulty: "EASY", order: 2, explanation: "3x = 15，所以 x = 5。" } ] } } });
  return true;
}
