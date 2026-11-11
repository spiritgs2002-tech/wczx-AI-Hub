import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createToken } from "@/lib/auth";
import bcrypt from "bcryptjs";

// ⛔ DO NOT ADD BACK：此处原有登录上报函数，每次教师登录都把姓名、手机号、邮箱、学校以明文 HTTP 发到第三方站点
//   （原作者的 maoyouhui.org，注释却写“匿名上报”，且留空环境变量也关不掉）。学校场景涉及个人信息保护，2026-11-11 移除。
//   如确需统计活跃度，只能上报不含个人信息的随机设备 ID，且必须默认关闭、由管理员显式开启。

export async function POST(req: NextRequest) {
  try {
    const { phone, password } = await req.json();

    if (!phone || !password) {
      return NextResponse.json(
        { error: "请填写手机号和密码" },
        { status: 400 }
      );
    }

    const user = await prisma.user.findFirst({
      where: { phone },
    });
    if (!user || !user.password) {
      return NextResponse.json(
        { error: "手机号或密码错误" },
        { status: 401 }
      );
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return NextResponse.json(
        { error: "手机号或密码错误" },
        { status: 401 }
      );
    }

    const token = await createToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    });

    return NextResponse.json({
      token,
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        name: user.name,
        school: user.school,
        role: user.role,
        motto: user.motto,
        studentMotto: user.studentMotto,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    const message = error instanceof Error ? error.message : "登录失败";
    return NextResponse.json({ error: "登录失败", detail: message }, { status: 500 });
  }
}
