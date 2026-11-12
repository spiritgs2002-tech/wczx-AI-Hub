import { NextRequest, NextResponse } from "next/server";
import { requireTeacher } from "@/lib/api-auth";
import { listImaItems } from "@/lib/ima";
import { imaErrorResponse, requireImaCredentials } from "../_shared";

export const dynamic = "force-dynamic";

/** GET /api/ima/items?kbId=&folderId=&cursor= —— 浏览 ima 知识库（文件夹）内容 */
export async function GET(req: NextRequest) {
  const auth = await requireTeacher(req);
  if (auth instanceof NextResponse) return auth;
  const kbId = req.nextUrl.searchParams.get("kbId");
  if (!kbId) return NextResponse.json({ error: "缺少 kbId" }, { status: 400 });
  const creds = await requireImaCredentials();
  if (creds instanceof NextResponse) return creds;
  try {
    const sp = req.nextUrl.searchParams;
    return NextResponse.json(await listImaItems(creds, kbId, sp.get("folderId") || undefined, sp.get("cursor") || ""));
  } catch (e) {
    return imaErrorResponse(e);
  }
}
