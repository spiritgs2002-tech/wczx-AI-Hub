#!/usr/bin/env node
/**
 * 安全回归测试（鉴权 / 越权 / 令牌 / 限流 / 上传 / 隐私）
 *
 * 为什么有它：2026-11-11 体检发现多处越权与无鉴权接口，修复后用本脚本防止回退。
 * 用法（必须用独立测试库，绝不能指向真实数据）：
 *   1. cp prisma/dev.db /tmp/wczx-test.db（或任意测试库），确保表结构已 db push
 *   2. DATABASE_URL="file:/tmp/wczx-test.db" npx next dev -p 3919
 *   3. TEST_DATABASE_URL="file:/tmp/wczx-test.db" TEST_BASE_URL="http://127.0.0.1:3919" node scripts/test-security.mjs
 * 脚本会在测试库里创建/复用以 sec-test 开头的测试数据（两名教师、班级、学生、对话活动），不删除任何已有数据。
 * ⛔ 拒绝在 DATABASE 路径以 prisma/dev.db 结尾时运行，防止误改真实数据。
 * 🔗 RELATED：src/lib/api-auth.ts、src/lib/auth.ts、src/lib/rate-limit.ts、src/lib/project-submit.ts。
 */
import { createRequire } from "module";
import path from "path";

const require = createRequire(import.meta.url);
const BASE = process.env.TEST_BASE_URL || "http://127.0.0.1:3919";
const DB = process.env.TEST_DATABASE_URL || "";
if (!DB.startsWith("file:") || /prisma[\\/]dev\.db$/.test(DB)) {
  console.error("请设置 TEST_DATABASE_URL 指向独立测试库（不能是 prisma/dev.db）");
  process.exit(2);
}

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const { SignJWT } = require("jose");
const prisma = new PrismaClient({ datasources: { db: { url: DB } } });

let failed = 0;
const H = { "Content-Type": "application/json" };
const auth = (t) => ({ ...H, Authorization: `Bearer ${t}` });
async function expect(label, url, opt, wantStatus) {
  const r = await fetch(BASE + url, opt);
  const ok = Array.isArray(wantStatus) ? wantStatus.includes(r.status) : r.status === wantStatus;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${label.padEnd(36)} 期望 ${wantStatus} 实际 ${r.status}`);
  return r;
}

// ---------- 测试数据 ----------
const PASS = "SecTest#2026";
const hash = await bcrypt.hash(PASS, 10);
async function upsertTeacher(phone, name) {
  const u = await prisma.user.findFirst({ where: { phone } });
  if (u) return prisma.user.update({ where: { id: u.id }, data: { password: hash, role: "TEACHER" } });
  return prisma.user.create({ data: { phone, name, role: "TEACHER", password: hash } });
}
const tA = await upsertTeacher("19900000001", "sec-test-教师A");
const tB = await upsertTeacher("19900000002", "sec-test-教师B");
let cls = await prisma.class.findFirst({ where: { inviteCode: "SECTEST1" } });
if (!cls) cls = await prisma.class.create({ data: { name: "sec-test-班级", teacherId: tA.id, inviteCode: "SECTEST1" } });
let stu = await prisma.user.findFirst({ where: { name: "sec-test-学生", role: "STUDENT" } });
if (!stu) stu = await prisma.user.create({ data: { name: "sec-test-学生", role: "STUDENT", classId: cls.id } });
else await prisma.user.update({ where: { id: stu.id }, data: { password: null, classId: cls.id } });
let task = await prisma.learningTask.findFirst({ where: { title: "sec-test-任务", teacherId: tA.id } });
if (!task) task = await prisma.learningTask.create({ data: { title: "sec-test-任务", objectives: "-", requirements: "-", teacherId: tA.id, updatedAt: new Date() } });
let sp = await prisma.subProject.findFirst({ where: { taskId: task.id } });
if (!sp) sp = await prisma.subProject.create({ data: { taskId: task.id, title: "sec-test-子项目", objectives: "-", requirements: "-" } });
let pc = await prisma.presetConversation.findFirst({ where: { subProjectId: sp.id } });
if (!pc) pc = await prisma.presetConversation.create({ data: { subProjectId: sp.id, title: "sec-test-对话活动" } });

const login = async (phone, password = PASS) => {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: H, body: JSON.stringify({ phone, password }) });
  return (await r.json()).token;
};
const tokA = await login("19900000001");
const tokB = await login("19900000002");
const tokS = (await (await fetch(`${BASE}/api/auth/student-login`, { method: "POST", headers: H, body: JSON.stringify({ name: stu.name, inviteCode: "SECTEST1" }) })).json()).token;
if (!tokA || !tokB || !tokS) { console.error("获取测试令牌失败", { tokA: !!tokA, tokB: !!tokB, tokS: !!tokS }); process.exit(1); }

console.log("\n== 对话活动：教师角色 + 归属");
await expect("学生 读取对话活动", `/api/preset-conversations/${pc.id}`, { headers: auth(tokS) }, 403);
await expect("学生 删除对话活动", `/api/preset-conversations/${pc.id}`, { method: "DELETE", headers: auth(tokS) }, 403);
await expect("学生 新建对话活动", `/api/preset-conversations`, { method: "POST", headers: auth(tokS), body: JSON.stringify({ subProjectId: sp.id, title: "x" }) }, 403);
await expect("教师B 读取教师A的活动", `/api/preset-conversations/${pc.id}`, { headers: auth(tokB) }, 404);
await expect("教师B 删除教师A的活动", `/api/preset-conversations/${pc.id}`, { method: "DELETE", headers: auth(tokB) }, 404);
await expect("教师B 在教师A子项目新建", `/api/preset-conversations`, { method: "POST", headers: auth(tokB), body: JSON.stringify({ subProjectId: sp.id, title: "x" }) }, 404);
await expect("教师A 读取自己的活动", `/api/preset-conversations/${pc.id}`, { headers: auth(tokA) }, 200);

console.log("\n== 排序接口：归属");
for (const [kind, body] of [
  ["exploration-activities", { explorationId: "x", direction: "up", subProjectId: sp.id }],
  ["quiz-activities", { quizId: "x", direction: "up", subProjectId: sp.id }],
  ["project-submissions", { submissionId: "x", direction: "up", subProjectId: sp.id }],
]) {
  await expect(`学生 ${kind} 排序`, `/api/${kind}/reorder`, { method: "POST", headers: auth(tokS), body: JSON.stringify(body) }, 403);
  await expect(`教师B ${kind} 排序`, `/api/${kind}/reorder`, { method: "POST", headers: auth(tokB), body: JSON.stringify(body) }, 404);
}

console.log("\n== 仅教师可用的系统接口");
await expect("未登录 测试AI连接", `/api/system-config/test`, { method: "POST", headers: H, body: "{}" }, 401);
await expect("学生 测试AI连接", `/api/system-config/test`, { method: "POST", headers: auth(tokS), body: "{}" }, 403);
await expect("未登录 重载AI队列", `/api/system-config/reload-queue`, { method: "POST" }, 401);
await expect("学生 AI生成探究页", `/api/exploration-activities/generate`, { method: "POST", headers: auth(tokS), body: "{}" }, 403);
await expect("学生 一键更新", `/api/upgrade/download`, { method: "POST", headers: auth(tokS) }, 403);
const form = () => { const f = new FormData(); f.append("file", new Blob([Buffer.from("PK\x03\x04")]), "u.zip"); return f; };
await expect("未登录 上传升级包", `/api/upgrade/install`, { method: "POST", body: form() }, 401);
await expect("学生 上传升级包", `/api/upgrade/install`, { method: "POST", headers: { Authorization: `Bearer ${tokS}` }, body: form() }, 403);

console.log("\n== 令牌");
const secretForge = await new SignJWT({ userId: tA.id, role: "TEACHER" }).setProtectedHeader({ alg: "HS256" })
  .setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode("wczx-ai-hub-secret-key-2024"));
await expect("公开密钥伪造的教师令牌", `/api/auth/teacher/profile`, { headers: auth(secretForge) }, 401);
const purposeTok = await new SignJWT({ userId: tA.id, role: "TEACHER", purpose: "x" }).setProtectedHeader({ alg: "HS256" })
  .setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode("unknown"));
await expect("带 purpose 的令牌不能登录", `/api/auth/teacher/profile`, { headers: auth(purposeTok) }, 401);
// 改密码后旧令牌失效、新令牌可用
const oldTok = await login("19900000002");
const r = await fetch(`${BASE}/api/auth/teacher/profile`, { method: "PUT", headers: auth(oldTok), body: JSON.stringify({ name: "sec-test-教师B", password: PASS + "x", oldPassword: PASS }) });
const newTok = (await r.json()).token;
await expect("改密码后 旧令牌", `/api/auth/teacher/profile`, { headers: auth(oldTok) }, 401);
await expect("改密码后 新令牌", `/api/auth/teacher/profile`, { headers: auth(newTok) }, 200);
await prisma.user.update({ where: { id: tB.id }, data: { password: hash } });

console.log("\n== 登录失败次数限制");
for (let i = 0; i < 10; i++) await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: H, body: JSON.stringify({ phone: "19900000009", password: "wrong" }) });
await expect("连续失败 10 次后再登录", `/api/auth/login`, { method: "POST", headers: H, body: JSON.stringify({ phone: "19900000009", password: "wrong" }) }, 429);

await prisma.$disconnect();
console.log(failed ? `\n✗ ${failed} 项未通过` : "\n✓ 全部通过");
process.exit(failed ? 1 : 0);
