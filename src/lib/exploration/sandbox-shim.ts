/**
 * 沙箱存储垫片：iframe 去掉 allow-same-origin 后是“不透明源”，页面脚本访问 localStorage / sessionStorage / document.cookie
 * 会抛 SecurityError，导致 AI 生成的互动页（常用 localStorage 存进度）整页报错。这里在最前面注入内存版替身，
 * 只在真实存储不可用时生效；数据不跨刷新保留（可接受，原先共用的是宿主站点的 localStorage，本身就不该被页面读写）。
 * 🔗 RELATED：使用方 src/app/student/chat/ExplorationPanel.tsx（学生端）、src/app/teacher/tasks/page.tsx（教师端预览）。
 */
export const SANDBOX_STORAGE_SHIM =
  "<script>(function(){function mk(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}" +
  "['localStorage','sessionStorage'].forEach(function(n){try{window[n].getItem('__probe')}catch(e){try{Object.defineProperty(window,n,{value:mk(),configurable:true})}catch(e2){}}});" +
  "try{void document.cookie}catch(e){try{Object.defineProperty(document,'cookie',{get:function(){return''},set:function(){},configurable:true})}catch(e2){}}})();</script>";

export function injectSandboxShim(html: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + SANDBOX_STORAGE_SHIM);
  return SANDBOX_STORAGE_SHIM + html;
}
