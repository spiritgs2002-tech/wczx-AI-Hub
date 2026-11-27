/**
 * 学生端「切换到 HTTPS 入口」辅助函数（仅浏览器端使用）。
 *
 * 为什么：浏览器只在安全来源开放麦克风。学生通过 http://教师IP:3000 进入时录音必然失败，
 *   旧做法只提示「请扫二维码重新进入」，学生手上往往没有二维码（2026-11-27 平板截图）。
 *   现在直接算出同一台教师电脑的 https 地址，给学生一个按钮即可跳过去。
 * 📐 CONTRACT：getHttpsSwitchUrl(path) —— 当前已是安全来源（https / localhost）或服务端未开 HTTPS 入口时返回 null；
 *   否则返回 `https://当前主机名:入口端口${path}`。
 * ⚠️ GOTCHA：https 入口与 http 是不同来源，localStorage 不共享 —— 跳转后学生需重新登录一次，所以统一跳到 /student 登录页。
 * ⛔ DO NOT 改成自动跳转：若教师电脑防火墙只放行了 3000，自动跳转会让学生整站打不开；保留“学生点按钮才跳”。
 * 🔗 RELATED：src/app/api/system/https-entry/route.ts、src/app/student/page.tsx、src/app/student/chat/page.tsx。
 */
let cached: Promise<number | null> | null = null;

function fetchHttpsPort(): Promise<number | null> {
  if (!cached) {
    cached = fetch("/api/system/https-entry", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (typeof d?.httpsPort === "number" ? d.httpsPort : null))
      .catch(() => null)
      .then((port) => {
        if (port === null) cached = null; // 失败不缓存，下次再试
        return port;
      });
  }
  return cached;
}

export async function getHttpsSwitchUrl(path: string): Promise<string | null> {
  if (typeof window === "undefined" || window.isSecureContext) return null;
  const port = await fetchHttpsPort();
  if (!port) return null;
  return `https://${window.location.hostname}:${port}${path}`;
}
