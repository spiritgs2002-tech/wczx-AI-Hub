import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireTeacher, ownsPresetConversation } from "@/lib/api-auth";

// PATCH: 切换对话活动生效/失效
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ presetConversationId: string }> }
) {
  try {
    const { presetConversationId } = await params;
    const auth = await requireTeacher(req);
    if (auth instanceof NextResponse) return auth;
    if (!(await ownsPresetConversation(presetConversationId, auth.userId))) {
      return new NextResponse("对话活动不存在", { status: 404 });
    }

    const body = await req.json();
    const enabled = body.enabled === true;

    await prisma.presetConversation.update({
      where: { id: presetConversationId },
      data: { enabled },
    });

    return NextResponse.json({ success: true, enabled });
  } catch (e) {
    console.error(e);
    return new NextResponse("切换失败", { status: 500 });
  }
}
