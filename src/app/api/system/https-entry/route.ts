import { NextResponse } from "next/server";
import { getHttpsEntry } from "@/lib/https-entry";

// ⛔ DO NOT REMOVE: MUST stay force-dynamic —— 入口端口是运行期状态，不能在构建期固化。
export const dynamic = "force-dynamic";

/**
 * GET /api/system/https-entry —— 返回局域网 HTTPS 入口正在监听的端口（未启动为 null）。
 *
 * 为什么：学生用 http://教师IP:3000 进入时浏览器禁用麦克风，前端需要知道 https 入口端口，
 *   才能给出「一键切换到 HTTPS」按钮（2026-11-27 平板实测：学生手输 http 地址进入，录音报错后不知道怎么办）。
 * 📐 CONTRACT：{ httpsPort: number | null }；无需登录（学生登录页也要用），只暴露端口号，不含任何地址或账号信息。
 * 🔗 RELATED：src/lib/https-entry.ts（入口本体）、src/lib/https-switch.ts（前端调用方）。
 */
export async function GET() {
  return NextResponse.json({ httpsPort: getHttpsEntry()?.port ?? null });
}
