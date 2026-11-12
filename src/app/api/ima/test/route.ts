import { NextRequest, NextResponse } from "next/server";
import { requireTeacher } from "@/lib/api-auth";
import { listImaKnowledgeBases } from "@/lib/ima";
import { imaErrorResponse, requireImaCredentials } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * POST /api/ima/test —— 测试 ima 凭证。
 * body 可带 { clientId, apiKey } 测试尚未保存的值；不带则测试已保存的凭证。成功返回知识库数量与前几个名称。
 */
export async function POST(req: NextRequest) {
  const auth = await requireTeacher(req);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  let creds;
  if (body?.clientId && body?.apiKey) {
    creds = { clientId: String(body.clientId).trim(), apiKey: String(body.apiKey).trim() };
  } else {
    creds = await requireImaCredentials();
    if (creds instanceof NextResponse) return creds;
  }
  try {
    const kbs = await listImaKnowledgeBases(creds);
    return NextResponse.json({ ok: true, count: kbs.length, names: kbs.slice(0, 5).map((k) => k.name) });
  } catch (e) {
    return imaErrorResponse(e);
  }
}
