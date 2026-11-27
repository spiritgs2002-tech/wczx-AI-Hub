import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { lockedMinutes, recordFailure, clearFailures, tooManyAttemptsMessage } from "@/lib/rate-limit";

// 方式二：通过密钥文件恢复密码
export async function POST(req: NextRequest) {
  try {
    const { phone, recoveryKey, newPassword } = await req.json();

    if (!phone || !recoveryKey) {
      return NextResponse.json(
        { error: "请上传密钥文件并填写信息" },
        { status: 400 }
      );
    }

    // MUST REQUIRE NEW PASSWORD: 不再允许缺省重置为固定弱密码（2026-11-27 审核发现）。
    // 📐 CONTRACT：newPassword 必填且不少于 6 位；账号不存在与验证失败返回同一提示并计入失败次数，避免探测手机号。
    // 🔗 RELATED：src/app/forgot-password/page.tsx（输入新密码）、另一个找回接口 recover-password。⛔ DO NOT REVERT。
    if (typeof newPassword !== "string" || newPassword.length < 6) {
      return NextResponse.json({ error: "新密码至少 6 位" }, { status: 400 });
    }

    // 失败次数限制（⛔ DO NOT REMOVE：防暴力猜解，见 src/lib/rate-limit.ts）
    const rlKey = `recover-key:${String(phone).trim()}`;
    const waitMin = lockedMinutes(rlKey);
    if (waitMin > 0) {
      return NextResponse.json({ error: tooManyAttemptsMessage(waitMin) }, { status: 429 });
    }

    const user = await prisma.user.findFirst({ where: { phone } });
    if (!user) {
      recordFailure(rlKey);
      return NextResponse.json({ error: "密钥文件无效" }, { status: 401 });
    }

    if (!user.passwordKeyHash) {
      return NextResponse.json({ error: "该用户未生成密钥文件" }, { status: 400 });
    }

    // 验证密钥文件
    const isValid = await bcrypt.compare(recoveryKey, user.passwordKeyHash);
    if (!isValid) {
      recordFailure(rlKey);
      return NextResponse.json({ error: "密钥文件无效" }, { status: 401 });
    }

    // 更新密码
    clearFailures(rlKey);
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });

    return NextResponse.json({ success: true, message: "密码已恢复" });
  } catch (error) {
    console.error("Password recovery error:", error);
    return NextResponse.json({ error: "恢复失败" }, { status: 500 });
  }
}
