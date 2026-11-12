import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyToken, createToken } from "@/lib/auth";
import bcrypt from "bcryptjs";

// GET: 获取当前用户信息
export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }
    const payload = await verifyToken(token);
    if (!payload) {
      return NextResponse.json({ error: "无效的 token" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: String(payload.userId) },
      select: {
        id: true,
        email: true,
        name: true,
        gender: true,
        phone: true,
        school: true,
        role: true,
        motto: true,
        studentMotto: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "用户不存在" }, { status: 404 });
    }

    return NextResponse.json(user);
  } catch (error) {
    console.error("Get profile error:", error);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}

// PUT: 更新用户信息
export async function PUT(req: NextRequest) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }
    const payload = await verifyToken(token);
    if (!payload) {
      return NextResponse.json({ error: "无效的 token" }, { status: 401 });
    }

    const body = await req.json();
    const { password, oldPassword, motto, studentMotto, school, gender, name, phone, email } = body;

    // 如果要修改密码，必须提供旧密码
    if (password && !oldPassword) {
      return NextResponse.json({ error: "请输入当前密码" }, { status: 400 });
    }

    const currentUser = await prisma.user.findUnique({
      where: { id: String(payload.userId) },
      select: { phone: true, password: true },
    });
    if (!currentUser) {
      return NextResponse.json({ error: "用户不存在" }, { status: 404 });
    }

    // 手机号 = 教师登录账号（login 按 phone 查找；忘记密码/恢复密钥也按 phone 查找，改号后用新号即可）。
    // ⚠️ GOTCHA：修改手机号必须校验当前密码，防止他人在已登录的电脑上悄悄改掉登录账号。
    // 📐 CONTRACT：User.phone 为 @unique，这里先查重给出友好提示，update 时的 P2002 兜底并发冲突。
    let phoneToSet: string | undefined;
    if (phone !== undefined) {
      const trimmedPhone = typeof phone === "string" ? phone.trim() : "";
      if (!/^1\d{10}$/.test(trimmedPhone)) {
        return NextResponse.json({ error: "请输入 11 位手机号" }, { status: 400 });
      }
      if (trimmedPhone !== currentUser.phone) {
        if (!oldPassword) {
          return NextResponse.json({ error: "修改手机号需要填写当前密码" }, { status: 400 });
        }
        if (!currentUser.password || !(await bcrypt.compare(oldPassword, currentUser.password))) {
          return NextResponse.json({ error: "当前密码错误" }, { status: 400 });
        }
        const taken = await prisma.user.findFirst({
          where: { phone: trimmedPhone, NOT: { id: String(payload.userId) } },
          select: { id: true },
        });
        if (taken) {
          return NextResponse.json({ error: "该手机号已被其他账号使用" }, { status: 409 });
        }
        phoneToSet = trimmedPhone;
      }
    }

    // 邮箱可选、可修改：留空即清除；仅做基本格式与长度校验（邮箱不参与登录）
    let emailToSet: string | null | undefined;
    if (email !== undefined) {
      const trimmedEmail = typeof email === "string" ? email.trim() : "";
      if (trimmedEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail) || trimmedEmail.length > 100)) {
        return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
      }
      emailToSet = trimmedEmail || null;
    }

    // 构建更新数据
    const updateData: Record<string, string | null> = {};
    if (school !== undefined) updateData.school = school;
    if (gender !== undefined) updateData.gender = gender;
    // 姓名可修改（设置页已放开输入框），服务端兜底校验：去首尾空格后必须非空且不超过 30 字
    if (name !== undefined) {
      const trimmedName = typeof name === "string" ? name.trim() : "";
      if (!trimmedName) {
        return NextResponse.json({ error: "姓名不能为空" }, { status: 400 });
      }
      if (trimmedName.length > 30) {
        return NextResponse.json({ error: "姓名不能超过 30 个字" }, { status: 400 });
      }
      updateData.name = trimmedName;
    }
    if (motto !== undefined) updateData.motto = motto;
    if (studentMotto !== undefined) updateData.studentMotto = studentMotto;
    if (phoneToSet !== undefined) updateData.phone = phoneToSet;
    if (emailToSet !== undefined) updateData.email = emailToSet;

    // 如果要修改密码，验证旧密码
    if (password && oldPassword) {
      if (!currentUser.password) {
        return NextResponse.json({ error: "用户密码不存在" }, { status: 400 });
      }

      const isValid = await bcrypt.compare(oldPassword, currentUser.password);
      if (!isValid) {
        return NextResponse.json({ error: "当前密码错误" }, { status: 400 });
      }

      updateData.password = await bcrypt.hash(password, 10);
    }

    const updatedUser = await prisma.user.update({
      where: { id: String(payload.userId) },
      data: updateData,
      select: {
        id: true,
        email: true,
        name: true,
        gender: true,
        phone: true,
        school: true,
        role: true,
        motto: true,
        studentMotto: true,
      },
    });

    // 改了密码 → 旧令牌已因密码指纹变化而失效（见 src/lib/auth.ts），这里给当前用户签发新令牌，避免保存后立即被登出。
    // 📐 CONTRACT：字段与登录接口签发的令牌一致；前端 settings 页收到 token 字段后写回 localStorage。
    if (updateData.password) {
      const token = await createToken({
        userId: updatedUser.id,
        email: updatedUser.email,
        role: updatedUser.role,
        name: updatedUser.name,
      });
      return NextResponse.json({ ...updatedUser, token });
    }

    return NextResponse.json(updatedUser);
  } catch (error) {
    // 并发下两人同时改成同一手机号时，唯一约束冲突（P2002）在此兜底
    if ((error as { code?: string })?.code === "P2002") {
      return NextResponse.json({ error: "该手机号已被其他账号使用" }, { status: 409 });
    }
    console.error("Update profile error:", error);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}
