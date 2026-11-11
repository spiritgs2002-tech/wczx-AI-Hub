import { NextResponse } from "next/server";
import { readVersionInfoFromDir } from "@/lib/version-info";

// 最新版本信息文件地址（文昌中学自维护的 GitHub fork，main 分支的 public/latest.json）
// 📐 CONTRACT：升级源仓库 MUST STAY IN SYNC —— 与 src/app/api/upgrade/download/route.ts 的 RELEASE_REPO_URL 指向同一仓库，
//   否则会出现“检测到新版本，但一键更新下载的是另一个仓库的包”。
// 维护：发新版 = 在该仓库 main 上提高 public/latest.json 的 version，用户端即可检测到更新。
const LATEST_VERSION_URL =
  "https://raw.githubusercontent.com/spiritgs2002-tech/quickclass-release/main/public/latest.json";

/**
 * 检查版本更新
 * GET /api/version/check
 */
export async function GET() {
  try {
    // 1. 读取本地当前版本号（避免通过 HTTP 请求自身）
    //    优先 public/latest.json（当前版本号唯一真源），VERSION.md 兜底
    const currentVersion =
      readVersionInfoFromDir(process.cwd()).version || "unknown";

    // 2. 拉取最新版本信息
    const res = await fetch(LATEST_VERSION_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000), // 5 秒超时
    });

    if (!res.ok) {
      return NextResponse.json({
        current: currentVersion,
        hasUpdate: false,
        error: "无法获取最新版本信息",
      });
    }

    const latest = await res.json();
    const latestVersion = latest.version || "";

    // 3. 比较版本号
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    return NextResponse.json({
      current: currentVersion,
      latest: latestVersion,
      hasUpdate,
      downloadUrl: latest.downloadUrl || "",
      changelog: latest.changelog || "",
      releaseDate: latest.releaseDate || "",
    });
  } catch {
    return NextResponse.json({
      current: "unknown",
      hasUpdate: false,
      error: "版本检查失败",
    });
  }
}

/**
 * 比较版本号，返回 1 表示 v1 > v2，-1 表示 v1 < v2，0 表示相等
 */
function compareVersions(v1: string, v2: string): number {
  // 如果没有小版本号（如 -V2），默认补上 -V1
  const normalize = (v: string) => {
    const cleaned = v.replace(/^v/, "");
    return cleaned.includes("-") ? cleaned : `${cleaned}-V1`;
  };
  const clean = (v: string) => normalize(v).replace(/-/g, ".");
  const parts1 = clean(v1).split(".").map(Number);
  const parts2 = clean(v2).split(".").map(Number);
  const len = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < len; i++) {
    const a = parts1[i] || 0;
    const b = parts2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}
