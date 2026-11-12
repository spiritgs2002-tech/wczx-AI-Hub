import { NextRequest, NextResponse } from "next/server";
import { requireTeacher } from "@/lib/api-auth";
import { listImaKnowledgeBases } from "@/lib/ima";
import { imaErrorResponse, requireImaCredentials } from "../_shared";

export const dynamic = "force-dynamic";

/** GET /api/ima/knowledge-bases?q= —— 列出（或按名称搜索）当前 ima 账号的知识库 */
export async function GET(req: NextRequest) {
  const auth = await requireTeacher(req);
  if (auth instanceof NextResponse) return auth;
  const creds = await requireImaCredentials();
  if (creds instanceof NextResponse) return creds;
  try {
    const q = req.nextUrl.searchParams.get("q") || "";
    return NextResponse.json({ knowledgeBases: await listImaKnowledgeBases(creds, q) });
  } catch (e) {
    return imaErrorResponse(e);
  }
}
