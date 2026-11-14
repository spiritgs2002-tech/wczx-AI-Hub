/** 为已有教师补齐缺失的默认模板：npx tsx prisma/init-templates.ts */
import { PrismaClient } from "@prisma/client";
import { initializeDefaultTemplates } from "../src/lib/initialize-default-templates";

const prisma = new PrismaClient();

// MUST PRESERVE DEFAULTS: 已有默认模板和教师编辑内容均保留；重复运行只补缺失类别。
// 📐 CONTRACT: 教师名下每个缺少默认值的类别使用 starterTemplates 初始化。
// 🔗 RELATED: src/lib/initialize-default-templates.ts、prisma/seed-full.ts、注册路由。
// ⛔ DO NOT REVERT: 不得通过重置数据库或覆盖现有模板来初始化。
async function main() {
  const teachers = await prisma.user.findMany({ where: { role: "TEACHER" }, select: { id: true } });
  for (const teacher of teachers) {
    await prisma.$transaction((tx) => initializeDefaultTemplates(tx, teacher.id));
  }
  console.log(`已检查 ${teachers.length} 位教师的默认模板`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
