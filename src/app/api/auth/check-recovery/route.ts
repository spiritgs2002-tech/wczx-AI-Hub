import { NextRequest, NextResponse } from "next/server";

// ⛔ DO NOT REVERT: Never expose account-specific recovery flags before credential verification.
// 📐 CONTRACT: compatibility endpoint advertises both workflows; 🔗 RELATED: forgot-password and recover-* routes.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (typeof body?.phone !== "string" || !body.phone.trim()) {
    return NextResponse.json({ error: "请提供手机号" }, { status: 400 });
  }
  return NextResponse.json({ hasQuestion: true, hasKey: true });
}
