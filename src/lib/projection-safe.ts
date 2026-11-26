"use client";

import { useEffect, useState } from "react";

export const PROJECTION_SAFE_KEY = "projection-safe";
export const PROJECTION_SAFE_EVENT = "wczx-projection-safe-changed";

let volatileSetting: boolean | undefined;

export function getProjectionSafe(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(PROJECTION_SAFE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveProjectionSafe(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROJECTION_SAFE_KEY, String(enabled));
    volatileSetting = undefined;
  } catch {
    // 屏蔽存储的浏览器仍能在当前标签页切换，刷新后按默认值启动。
    volatileSetting = enabled;
  }
  window.dispatchEvent(new Event(PROJECTION_SAFE_EVENT));
}

// MUST KEEP PROJECTION STATE CLIENT SIDE: 当页组件靠事件同步，其他标签页靠 storage 同步。
// 📐 CONTRACT: 默认关闭；🔗 RELATED: TeacherLayout 顶栏和探究大屏消费同一个状态。
// ⛔ DO NOT REVERT: 监听必须成对解绑，状态不进入网络请求或提示词。
export function useProjectionSafe(): boolean {
  const [safe, setSafe] = useState(getProjectionSafe);
  useEffect(() => {
    const sync = () => setSafe(volatileSetting ?? getProjectionSafe());
    const syncStorage = (event: StorageEvent) => {
      if (event.key === PROJECTION_SAFE_KEY || event.key === null) {
        volatileSetting = undefined;
        sync();
      }
    };
    window.addEventListener(PROJECTION_SAFE_EVENT, sync);
    window.addEventListener("storage", syncStorage);
    sync();
    return () => {
      window.removeEventListener(PROJECTION_SAFE_EVENT, sync);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);
  return safe;
}

export function maskDisplayName(_raw: string, index: number): string {
  return `同学 ${index + 1}`;
}

/** 明确的姓名字段。与统计用的宽松标识字段识别分开，避免误改其他详情值。 */
export function isProjectionNameField(key: string): boolean {
  return key.includes("姓名") || /^(?:名字|昵称|学生名字|学生昵称|name|nickname|student[_ -]?name)$/i.test(key.trim());
}
