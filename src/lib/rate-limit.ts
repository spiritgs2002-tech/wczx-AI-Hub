/**
 * 登录类接口的失败次数限制（进程内存实现）
 *
 * 为什么：登录 / 学生密码登录 / 找回密码接口原先没有任何次数限制，局域网内可无限次猜密码（2026-11-11 体检发现）。
 * 现状：同一账号键在 15 分钟内失败 10 次 → 锁定到窗口结束；登录成功即清零。
 *   单进程部署（本项目就是一台教师电脑跑一个 next start），用内存 Map 即可；重启服务会清空计数（可接受）。
 * ⚠️ GOTCHA：按“账号”而不是按 IP 计数 —— next start 直连时拿不到可靠的客户端 IP。
 *   代价是有人故意输错可以把某个账号锁 15 分钟；相比被暴力破解，这是可接受的取舍。
 * 🔗 RELATED：src/app/api/auth/login、student-login、recover-key、recover-password。
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

type Entry = { failures: number; windowStart: number };
const store = new Map<string, Entry>();

function current(key: string): Entry | null {
  const e = store.get(key);
  if (!e) return null;
  if (Date.now() - e.windowStart > WINDOW_MS) {
    store.delete(key);
    return null;
  }
  return e;
}

/** 已被锁定时返回需要等待的分钟数，否则返回 0 */
export function lockedMinutes(key: string): number {
  const e = current(key);
  if (!e || e.failures < MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((e.windowStart + WINDOW_MS - Date.now()) / 60000));
}

export function recordFailure(key: string): void {
  const e = current(key);
  if (e) e.failures += 1;
  else store.set(key, { failures: 1, windowStart: Date.now() });
  // 防止 Map 无限增长：超过 5000 个键时清掉已过期的
  if (store.size > 5000) {
    store.forEach((v, k) => {
      if (Date.now() - v.windowStart > WINDOW_MS) store.delete(k);
    });
  }
}

export function clearFailures(key: string): void {
  store.delete(key);
}

export function tooManyAttemptsMessage(minutes: number): string {
  return `尝试次数过多，请 ${minutes} 分钟后再试`;
}
