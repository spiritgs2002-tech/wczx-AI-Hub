import { NextResponse } from "next/server";
import { prepareUpgradeFromBuffer } from "@/lib/upgrade-prepare";
import { verifyToken } from "@/lib/auth";

/**
 * 安装升级包
 * POST /api/upgrade/install
 * Body: multipart/form-data, field name="file"
 *
 * 公共准备逻辑（解压/校验/备份数据库/写标记）见 @/lib/upgrade-prepare
 */
export async function POST(request: Request) {
  try {
    // ⛔ DO NOT REMOVE：仅教师可上传升级包。升级包会在下次运行 start 脚本时覆盖程序代码并执行 npm install，
    //   无鉴权 = 局域网内任何人（含学生）都能在教师电脑上执行任意代码（2026-11-11 体检发现）。
    // ⚠️ GOTCHA：这里返回 JSON 错误而不是纯文本 —— 设置页 handleUpgrade 直接 res.json() 解析。
    // 🔗 RELATED：调用方 src/app/teacher/settings/page.tsx（已带 Authorization: Bearer）；一键更新 src/app/api/upgrade/download/route.ts。
    const token = request.headers.get("authorization")?.replace("Bearer ", "") || "";
    const payload = token ? await verifyToken(token) : null;
    if (!payload) {
      return NextResponse.json({ error: "未登录或登录已过期" }, { status: 401 });
    }
    if (payload.role !== "TEACHER") {
      return NextResponse.json({ error: "仅教师可安装升级包" }, { status: 403 });
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json(
        { error: "未收到升级包文件" },
        { status: 400 }
      );
    }

    if (!file.name.endsWith(".zip")) {
      return NextResponse.json(
        { error: "升级包必须是 .zip 格式" },
        { status: 400 }
      );
    }

    // 限制文件大小 200MB
    if (file.size > 200 * 1024 * 1024) {
      return NextResponse.json(
        { error: "升级包不能超过 200MB" },
        { status: 400 }
      );
    }

    // 读取文件内容并走公共升级准备流程
    const buffer = Buffer.from(await file.arrayBuffer());
    // 版本闸门：与一键更新一致，只允许安装更高版本，防止被降级到含已知漏洞的旧版
    const result = await prepareUpgradeFromBuffer(buffer, { requireNewer: true });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }

    return NextResponse.json({
      success: true,
      message: "升级包已准备就绪",
      newVersion: result.newVersion,
      detail: "请重启 wczx-AI-Hub 服务以完成升级",
    });
  } catch (error) {
    console.error("升级安装失败:", error);
    return NextResponse.json(
      { error: "升级安装失败: " + (error instanceof Error ? error.message : String(error)) },
      { status: 500 }
    );
  }
}
