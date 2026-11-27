import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  try {
    const { phone } = await req.json();

    if (!phone) {
      return NextResponse.json({ error: "请提供手机号" }, { status: 400 });
    }

    const user = await prisma.user.findFirst({ where: { phone } });
    // ⛔ DO NOT REVERT：不存在的手机号与「未设置恢复方式」返回相同结果，避免借此探测哪些手机号已注册（2026-11-27 审核发现）。
    if (!user) {
      return NextResponse.json({ hasQuestion: false, hasKey: false });
    }

    return NextResponse.json({
      hasQuestion: !!user.recoveryQuestion,
      hasKey: !!user.passwordKeyHash,
    });
  } catch (error) {
    console.error("Check recovery error:", error);
    return NextResponse.json({ error: "检查失败" }, { status: 500 });
  }
}