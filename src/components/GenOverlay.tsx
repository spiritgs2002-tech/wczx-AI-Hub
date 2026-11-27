"use client";

import { useEffect, useRef, useState } from "react";

// ============================================================
// AI 生成过程浮层：点击「分析/重新分析」等长耗时 AI 操作时弹出，
// 显示操作文案 + 真实递增秒数，完成后由调用方 stopGenOverlay() 关闭。
// ------------------------------------------------------------
// 三态非阻塞交互（用户生成期间可继续查看/浏览其他内容）：
//   展开态    顶部居中小卡片，无遮罩、不挡下方内容；右上角「—」手动收起
//   最小化态  右下角胶囊（小圈 + 文案 + 秒数），点击胶囊展开回顶部
//   自动收起  展开态下点击卡片外任意内容 → 缩到右下角（不阻断该次点击）
//   结束      stopGenOverlay() 关闭（展开/最小化均适用），成功/失败提示照旧
// ⚠ 重复提交防护不靠本组件：组件无遮罩，调用方按钮需自行 disabled，
//   且生成函数入口建议用 ref guard（state 闭包在同一渲染周期读不到新值）。
// ============================================================
// ⛔ DO NOT REPLACE with MessagePlugin.loading / Dialog:
// 旧写法每秒 `msg.close()` + `MessagePlugin.loading(...)` 重建 —— TDesign 每次调用都向
// 容器 push 一条新 message，旧 loading 消息的 fadeOut 异步退出动画未跑完就被新消息盖住，
// 栈顶那条永远显示 "0s" 且圆圈一直转（历史 bug：用户报「秒数一直是 0，圆圆一直滚动」）。
// 单一 React 浮层 + useState 计数从根本上杜绝消息堆叠。
// 🔗 RELATED: 首个内联实现在 src/app/teacher/tasks/page.tsx（genOverlay），后续页面
// 逐个切换到本组件，最终删除该内联实现。
// ============================================================

export interface GenOverlayState {
  visible: boolean;
  text: string;
  seconds: number;
  /** 流式生成时已收到的正文（可选）：有内容时展开态卡片下方实时显示，边生成边看 */
  preview?: string;
}

/** 浮层状态 + 控制器：start(初始文案) / update(切换文案) / stop(关闭并清计时器) */
export function useGenOverlay() {
  const [genOverlay, setGenOverlay] = useState<GenOverlayState>({
    visible: false,
    text: "",
    seconds: 0,
  });
  const genTimerRef = useRef<NodeJS.Timeout | null>(null);
  const genStartRef = useRef<number>(0);

  const startGenOverlay = (initialText: string) => {
    genStartRef.current = Date.now();
    setGenOverlay({ visible: true, text: initialText, seconds: 0, preview: "" });
    if (genTimerRef.current) clearInterval(genTimerRef.current);
    genTimerRef.current = setInterval(() => {
      setGenOverlay((prev) => ({ ...prev, seconds: Math.round((Date.now() - genStartRef.current) / 1000) }));
    }, 1000);
  };

  // preview 传入时同步更新实时正文；不传保持原值（只换文案）
  const updateGenOverlay = (text: string, preview?: string) =>
    setGenOverlay((prev) => ({ ...prev, text, ...(preview !== undefined ? { preview } : {}) }));

  const stopGenOverlay = () => {
    if (genTimerRef.current) {
      clearInterval(genTimerRef.current);
      genTimerRef.current = null;
    }
    setGenOverlay((prev) => ({ ...prev, visible: false }));
  };

  // 卸载兜底：页面跳转时清掉计时器，避免对已卸载组件 setState
  useEffect(() => {
    return () => {
      if (genTimerRef.current) clearInterval(genTimerRef.current);
    };
  }, []);

  return { genOverlay, startGenOverlay, updateGenOverlay, stopGenOverlay };
}

/**
 * 浮层渲染：放在页面根节点（TeacherLayout 内）。无遮罩不挡操作；
 * 点击卡片外任意内容自动缩到右下角胶囊，点击胶囊展开回顶部。
 * （pointerdown capture 保证先于页面内合成事件；页面内部件 stopPropagation
 * 不影响 document 原生 capture 监听。）
 */
// 实时预览只显示纯文字：HTML 报告去掉样式/脚本与标签，避免把源码糊在卡片上
function toPreviewText(raw: string): string {
  return raw
    .replace(/<(style|script)[\s\S]*?(<\/\1>|$)/gi, "")
    .replace(/<[^>]*>?/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

export function GenOverlay({ visible, text, seconds, preview }: GenOverlayState) {
  const [minimized, setMinimized] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);

  // 实时预览自动滚到底部，始终看到最新生成的内容
  useEffect(() => {
    if (previewRef.current) previewRef.current.scrollTop = previewRef.current.scrollHeight;
  }, [preview, minimized]);

  // 每次新 start（visible false→true）恢复展开态
  useEffect(() => {
    if (visible) setMinimized(false);
  }, [visible]);

  // 展开态：点击卡片外任意内容 → 自动最小化到右下角
  useEffect(() => {
    if (!visible || minimized) return;
    const onPointerDown = (e: PointerEvent) => {
      if (cardRef.current && e.target instanceof Node && !cardRef.current.contains(e.target)) {
        setMinimized(true);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [visible, minimized]);

  if (!visible) return null;

  // 最小化态：右下角胶囊，点击展开回顶部
  if (minimized) {
    return (
      <div className="fixed bottom-6 right-6 z-[3000]" onClick={() => setMinimized(false)} title="点击展开">
        <div className="bg-white rounded-full pl-3.5 pr-4 py-2 flex items-center gap-2 shadow-lg border border-gray-100 cursor-pointer hover:shadow-xl transition-shadow">
          <span className="inline-block w-4 h-4 border-2 border-blue-100 border-t-[#0052D9] rounded-full animate-spin shrink-0" />
          <span className="text-xs text-gray-600 max-w-[180px] truncate">{text}</span>
          <span className="text-xs text-gray-400 tabular-nums shrink-0">{seconds}s</span>
        </div>
      </div>
    );
  }

  // 展开态：顶部居中小卡片，无遮罩；容器 pointer-events-none 不挡下方内容
  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[3000] pointer-events-none">
      <div
        ref={cardRef}
        className="pointer-events-auto relative bg-white/95 backdrop-blur rounded-xl pl-8 pr-9 py-4 flex flex-col gap-3 shadow-2xl border border-gray-100"
      >
        <div className="flex items-center gap-3">
          <span className="inline-block w-6 h-6 border-[3px] border-blue-100 border-t-[#0052D9] rounded-full animate-spin shrink-0" />
          <div className="flex flex-col">
            <span className="text-sm text-gray-700 whitespace-nowrap">{text}</span>
            <span className="text-xs text-gray-400 tabular-nums">{seconds}s</span>
          </div>
        </div>
        {preview ? (
          <div
            ref={previewRef}
            className="w-[min(640px,80vw)] max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-gray-600 bg-gray-50 rounded-lg px-3 py-2 border border-gray-100"
          >
            {toPreviewText(preview)}
          </div>
        ) : null}
        <button
          className="absolute top-1.5 right-1.5 w-5 h-5 flex items-center justify-center text-gray-300 hover:text-gray-600 rounded transition-colors"
          onClick={() => setMinimized(true)}
          title="收起（生成不会中断，缩到右下角）"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
