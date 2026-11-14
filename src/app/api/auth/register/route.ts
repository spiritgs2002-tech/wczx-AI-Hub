import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createToken } from "@/lib/auth";
import bcrypt from "bcryptjs";
import { starterTemplates } from "@/lib/starter-templates";
import { seedInitialClass } from "@/../prisma/seed-initial";

export async function POST(req: NextRequest) {
  let accountCreated = false;
  try {
    // 本地部署只允许一个教师账号
    const teacherCount = await prisma.user.count({ where: { role: "TEACHER" } });
    if (teacherCount > 0) {
      return NextResponse.json(
        { error: "本地部署仅支持一个教师账号，请直接登录" },
        { status: 403 }
      );
    }

    const { phone, password, name, email, school, recoveryQuestion, recoveryAnswer } = await req.json();

    if (!phone || !password || !name) {
      return NextResponse.json(
        { error: "请填写所有必填项" },
        { status: 400 }
      );
    }

    const existing = await prisma.user.findFirst({ where: { phone } });
    if (existing) {
      return NextResponse.json(
        { error: "该手机号已被注册" },
        { status: 409 }
      );
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    let recoveryAnswerHash = null;
    let passwordKeyHash = null;

    // 如果设置了恢复问题，同时哈希存储答案
    if (recoveryQuestion && recoveryAnswer) {
      recoveryAnswerHash = await bcrypt.hash(recoveryAnswer, 10);
    }

    // 生成密码密钥文件
    const keyToken = crypto.randomUUID() + "-" + Date.now();
    if (recoveryQuestion && recoveryAnswer) {
      passwordKeyHash = await bcrypt.hash(keyToken, 10);
    }

    // MUST CREATE TOGETHER: 新安装注册后立即拥有六类默认模板，避免异步演示数据失败或延迟导致缺失。
    // 📐 CONTRACT: 只为新账号创建，不覆盖已有教师的模板；任一写入失败则事务回滚。
    // 🔗 RELATED: src/lib/starter-templates.ts、prisma/seed-full.ts、prisma/init-templates.ts。
    // ⛔ DO NOT REVERT: 不依赖 seed-demo 的后台执行，首次登录也必须能使用默认模板。
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
      data: {
        phone,
        email,
        password: hashedPassword,
        name,
        role: "TEACHER",
        school,
        recoveryQuestion,
        recoveryAnswerHash,
        passwordKeyHash,
      },
      });
      await tx.analysisTemplate.createMany({ data: Object.entries(starterTemplates).map(([type, template]) => ({
        teacherId: created.id, type, name: template.name, content: template.content,
        isDefault: true, updatedAt: new Date(),
      })) });
      await seedInitialClass(tx, created.id);
      return created;
    });
    accountCreated = true;

    // ⛔ DO NOT ADD BACK：不向任何第三方站点同步教师个人信息（原注释掉的 maoyouhui.org sync-user / check-phone 已于 2026-11-11 删除）

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
        role: user.role,
      },
      // 返回密钥文件内容（仅当设置了恢复问题时）
      recoveryKey: (recoveryQuestion && recoveryAnswer) ? keyToken : null,
    });
  } catch (error) {
    // MUST REPORT RESTORE RACE: 注册事务可能提交后才遇到维护锁，恢复完成后的账号状态须重新核实。
    // 📐 CONTRACT: 仅此场景返回 503，不承诺账号一定保留；🔗 RELATED: teacher-restore-lock.ts、auth.ts。
    // ⛔ DO NOT REVERT: 不能把已提交但未签发令牌的场景误报成普通注册失败。
    if (accountCreated && error instanceof Error && error.message.includes("系统正在恢复数据")) {
      return NextResponse.json({ error: "注册期间系统进入恢复，请恢复完成后尝试登录；若无法登录请联系管理员" }, { status: 503 });
    }
    console.error("Register error:", error);
    return NextResponse.json({ error: "注册失败" }, { status: 500 });
  }
}
