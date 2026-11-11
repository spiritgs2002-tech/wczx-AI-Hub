import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// ⛔ DO NOT REMOVE: this route MUST stay force-dynamic.
// 为什么：GET 不读 request 时，Next 14 会在 `npm run build` 阶段把它预渲染成静态 JSON，
//   座右铭被固化为构建时数据库里的值（打包机通常无库 → 永远是 null），
//   教师之后在设置里改座右铭，学生端始终看不到。
// 🧪 MEASURED（2026-11-11）：去掉本行时构建表把 /api/system-config/student-motto 标为 ○ (Static)；加上后为 ƒ (Dynamic)。
// 🔗 RELATED：调用方 src/components/layout/StudentLayout.tsx（学生端顶部座右铭）；
//   同类问题见 src/app/api/auth/check-users/route.ts。新增“无参数 GET + 查库”的接口都要加这一行。
export const dynamic = "force-dynamic";

// GET: 获取学生座右铭（无需登录）
export async function GET() {
  try {
    const config = await prisma.systemConfig.findFirst({
      select: { studentMotto: true },
    });
    return NextResponse.json({ studentMotto: config?.studentMotto || null });
  } catch (error) {
    console.error("Get student motto error:", error);
    return NextResponse.json({ studentMotto: null });
  }
}