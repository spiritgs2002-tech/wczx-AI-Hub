/**
 * Next.js 服务启动钩子（每次 next dev / next start 启动时执行一次）。
 * 现状：只用来启动局域网 HTTPS 入口（学生平板录音需要安全来源），详见 src/lib/https-entry.ts。
 * ⚠️ GOTCHA：Next 会把本文件同时编译给 nodejs 与 edge 两种运行时。必须写成
 *   `if (process.env.NEXT_RUNTIME === "nodejs") { await import(...) }` 这种原样形式，
 *   构建时才能在 edge 包里把整段剔除；写成提前 return 会让 edge 编译去解析 fs/https，整站 500（2026-11-12 实测）。
 * 🔗 RELATED：next.config.mjs experimental.instrumentationHook（Next 14 需显式开启，删掉它本文件就不会执行）。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startHttpsEntry } = await import("./lib/https-entry");
    await startHttpsEntry();
  }
}
