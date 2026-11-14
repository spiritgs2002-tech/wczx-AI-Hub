import { Prisma } from "@prisma/client";
import { starterTemplates } from "./starter-templates";

// MUST PRESERVE TEACHER CHOICES: 初始化和重复 seed 仅补缺少默认值的类别，不覆盖现有内容或默认选择。
// 📐 CONTRACT: 新环境每类得到一个默认模板；同名模板已存在时只设为默认，不改正文。
// 🔗 RELATED: prisma/seed-full.ts、prisma/init-templates.ts、src/app/api/auth/register/route.ts。
// ⛔ DO NOT REVERT: seed 可能对已有数据库运行，按名称覆盖正文会破坏教师编辑。
export async function initializeDefaultTemplates(db: Prisma.TransactionClient, teacherId: string) {
  for (const [type, template] of Object.entries(starterTemplates)) {
    const current = await db.analysisTemplate.findFirst({ where: { teacherId, type, isDefault: true } });
    if (current) continue;
    const existing = await db.analysisTemplate.findFirst({ where: { teacherId, type, name: template.name } });
    if (existing) {
      await db.analysisTemplate.update({ where: { id: existing.id }, data: { isDefault: true } });
    } else {
      await db.analysisTemplate.create({ data: { teacherId, type, ...template, isDefault: true, updatedAt: new Date() } });
    }
  }
}
