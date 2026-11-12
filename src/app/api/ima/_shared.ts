import { NextResponse } from "next/server";
import { ImaError, getImaCredentials, type ImaCredentials } from "@/lib/ima";

// 📐 CONTRACT：/api/ima/* 均为教师专用代理，浏览器不直连 ima、也拿不到凭证；错误统一 { error } + 合适状态码。
// 🔗 RELATED：src/lib/ima.ts；知识仓库页与课堂编辑页的 ima 栏。
export async function requireImaCredentials(): Promise<ImaCredentials | NextResponse> {
  const creds = await getImaCredentials();
  if (!creds) {
    return NextResponse.json(
      { error: "尚未配置 ima：请到「系统设置 → ima 知识库」填写 Client ID 和 API Key", code: "IMA_NOT_CONFIGURED" },
      { status: 400 },
    );
  }
  return creds;
}

export function imaErrorResponse(e: unknown) {
  if (e instanceof ImaError) return NextResponse.json({ error: e.message, retcode: e.retcode }, { status: 502 });
  console.error("[ima] 未知错误：", e);
  return NextResponse.json({ error: "ima 服务异常，请稍后重试" }, { status: 500 });
}
