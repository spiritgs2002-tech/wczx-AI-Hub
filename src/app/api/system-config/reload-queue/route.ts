import { NextRequest, NextResponse } from "next/server";
import { aiQueue } from "@/lib/ai-queue";
import { requireTeacher } from "@/lib/api-auth";

export async function POST(req: NextRequest) {
  try {
    // 仅教师可重载 AI 队列（⛔ DO NOT REMOVE：原先无鉴权，任何人可反复触发重载）；调用方设置页已带 Bearer
    const auth = await requireTeacher(req);
    if (auth instanceof NextResponse) return auth;

    await aiQueue.reloadConfig();
    return NextResponse.json({ success: true, message: "AI 队列配置已重载" });
  } catch (error) {
    console.error("重载 AI 队列配置失败:", error);
    return NextResponse.json(
      { error: "重载失败" }, 
      { status: 500 }
    );
  }
}
