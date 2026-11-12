import { NextRequest, NextResponse } from "next/server";
import { requireTeacher } from "@/lib/api-auth";
import { searchImaKnowledge } from "@/lib/ima";
import { imaErrorResponse, requireImaCredentials } from "../_shared";

export const dynamic = "force-dynamic";

/** GET /api/ima/search?kbId=&q= —— 在 ima 知识库里搜索（老师预览「学生提问时 AI 会检索到什么」） */
export async function GET(req: NextRequest) {
  const auth = await requireTeacher(req);
  if (auth instanceof NextResponse) return auth;
  const kbId = req.nextUrl.searchParams.get("kbId");
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (!kbId || !q) return NextResponse.json({ error: "缺少 kbId 或搜索词" }, { status: 400 });
  const creds = await requireImaCredentials();
  if (creds instanceof NextResponse) return creds;
  try {
    return NextResponse.json({ hits: await searchImaKnowledge(creds, kbId, q) });
  } catch (e) {
    return imaErrorResponse(e);
  }
}
