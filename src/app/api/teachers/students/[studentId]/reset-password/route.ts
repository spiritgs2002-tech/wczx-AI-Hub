import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/lib/auth";
import bcrypt from "bcryptjs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ studentId: string }> }
) {
  try {
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "");
    if (!token) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }

    const payload = await verifyToken(token);
    if (!payload || payload.role !== "TEACHER") {
      return NextResponse.json({ error: "权限不足" }, { status: 403 });
    }

    const { studentId } = await params;

    const student = await prisma.user.findUnique({
      where: { id: studentId },
    });

    if (!student || student.role !== "STUDENT") {
      return NextResponse.json({ error: "学生不存在" }, { status: 404 });
    }

    // 重置密码：设置为可通过环境变量配置的初始密码
    const hashedPassword = await bcrypt.hash(process.env.STUDENT_INITIAL_PASSWORD || "Student@2026", 10);
    await prisma.user.update({
      where: { id: studentId },
      data: { password: hashedPassword },
    });

    return NextResponse.json({
      message: "密码已重置为初始密码，请登录后自行修改",
      studentName: student.name,
    });
  } catch (error) {
    console.error("Reset student password error:", error);
    return NextResponse.json({ error: "重置失败" }, { status: 500 });
  }
}
