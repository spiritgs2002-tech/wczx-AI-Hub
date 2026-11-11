import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// ⛔ DO NOT REMOVE: this route MUST stay force-dynamic.
// 为什么：GET 不读 request 时，Next 14 会在构建阶段把它预渲染成静态 JSON，
//   “是否已有教师”被固化为构建时的结果（打包机通常无库 → 永远 hasTeacher:false）。
// 🧪 MEASURED（2026-11-11）：去掉本行时构建表标为 ○ (Static)；加上后为 ƒ (Dynamic)。
// 🔗 RELATED：首页 src/app/page.tsx 做同样的判断（已 force-dynamic）；同类问题见
//   src/app/api/system-config/student-motto/route.ts。
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // 只检测"教师用户"，与 /api/auth/register 保持一致
    // 本地部署只支持一个教师账号；学生加入班级时会动态创建，不影响此判断
    const teacherCount = await prisma.user.count({ where: { role: "TEACHER" } });
    return NextResponse.json({ hasTeacher: teacherCount > 0 });
  } catch (error) {
    console.error("Check users error:", error);
    // 出错时也按"无教师"处理，让用户能看到设置表单
    return NextResponse.json({ hasTeacher: false });
  }
}