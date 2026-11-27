import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = (body.name ?? "").toString().trim();
    const studentNo = (body.studentNo ?? "").toString().trim();
    const inviteCode = (body.inviteCode ?? "").toString().trim();

    if (!name || !inviteCode) {
      return NextResponse.json({ error: "姓名和邀请码不能为空" }, { status: 400 });
    }

    const classData = await prisma.class.findUnique({
      where: { inviteCode },
    });

    if (!classData) {
      return NextResponse.json({ error: "邀请码无效" }, { status: 404 });
    }

    if (classData.status !== "ACTIVE") {
      return NextResponse.json({ error: "该班级已结束" }, { status: 400 });
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        name,
        classId: classData.id,
        role: "STUDENT",
      },
    });

    // MUST MATCH STUDENT-LOGIN RULES: 本接口与 /api/auth/student-login 的「邀请码登录」口径必须一致。
    // 为什么：原先同名学生已存在时直接签发令牌，不看是否设过密码 —— 知道邀请码 + 同学姓名即可冒名登录（2026-11-27 审核发现）；
    //   新建账号也不检查班级是否开放邀请码注册。
    // 📐 CONTRACT：已设密码的账号拒绝邀请码登录；班级未开放邀请码时不新建学生。
    // 🔗 RELATED：src/app/api/auth/student-login/route.ts 情况1。⛔ DO NOT REVERT。
    if (existingUser?.password) {
      return NextResponse.json({ error: "您已设置密码，请使用姓名/学号+密码登录" }, { status: 401 });
    }
    if (!existingUser && !classData.openInviteCode) {
      return NextResponse.json({ error: "该班级未开放邀请码注册，请联系老师获取帮助" }, { status: 403 });
    }

    if (existingUser) {
      const token = await import("@/lib/auth").then((m) =>
        m.createToken({
          userId: existingUser.id,
          email: existingUser.email || "",
          role: existingUser.role,
          name: existingUser.name,
        })
      );
      return NextResponse.json({
        token,
        user: { id: existingUser.id, name: existingUser.name, role: existingUser.role },
        class: classData,
        classId: classData.id,
        className: classData.name,
      });
    }

    const newStudent = await prisma.user.create({
      data: {
        name,
        studentNo: studentNo || null,
        role: "STUDENT",
        classId: classData.id,
      },
    });

    const token = await import("@/lib/auth").then((m) =>
      m.createToken({
        userId: newStudent.id,
        email: newStudent.email || "",
        role: newStudent.role,
        name: newStudent.name,
      })
    );

    return NextResponse.json({
      token,
      user: { id: newStudent.id, name: newStudent.name, role: newStudent.role },
      class: classData,
      classId: classData.id,
      className: classData.name,
    });
  } catch (error) {
    console.error("Join class error:", error);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}
