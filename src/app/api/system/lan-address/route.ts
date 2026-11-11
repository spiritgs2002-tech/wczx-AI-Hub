import { NextResponse } from "next/server";
import os from "os";
import { verifyToken } from "@/lib/auth";

// ⛔ DO NOT REMOVE: MUST stay force-dynamic —— 否则构建期会把“打包机”的网卡地址固化进产物。
export const dynamic = "force-dynamic";

/**
 * GET /api/system/lan-address —— 返回本机（运行 wczx-AI-Hub 的教师电脑）的局域网 IPv4 地址
 *
 * 为什么需要：教师通常在本机用 http://localhost:3000 打开后台，浏览器拿不到本机局域网 IP，
 *   班级分享弹窗里的二维码 / 分享文本若用 localhost，学生手机扫码根本打不开。
 * 📐 CONTRACT：{ addresses: { ip: string; iface: string }[] }，私网地址（192.168 / 10 / 172.16-31）排前面；
 *   已排除回环与 169.254 自动地址。仅教师登录态可调用（Authorization: Bearer）。
 * 🔗 RELATED：调用方 src/app/teacher/classes/page.tsx 的分享弹窗（二维码 + 复制分享文本）。
 */
export async function GET(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "") || "";
  const payload = token ? await verifyToken(token) : null;
  if (!payload || payload.role !== "TEACHER") {
    return NextResponse.json({ error: "未登录或无权限" }, { status: 401 });
  }

  const isPrivate = (ip: string) =>
    ip.startsWith("192.168.") ||
    ip.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

  const addresses: { ip: string; iface: string }[] = [];
  for (const [iface, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos || []) {
      // Node 18 的 family 是 "IPv4"，个别版本为数字 4，两种都认
      const isV4 = info.family === "IPv4" || (info.family as unknown) === 4;
      if (!isV4 || info.internal || info.address.startsWith("169.254.")) continue;
      addresses.push({ ip: info.address, iface });
    }
  }
  addresses.sort((a, b) => Number(isPrivate(b.ip)) - Number(isPrivate(a.ip)));

  return NextResponse.json({ addresses });
}
