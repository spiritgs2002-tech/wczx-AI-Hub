"use client";

/**
 * 系统设置 →「ima 知识库」卡片：填写腾讯 ima 开放接口凭证、测试连接。
 * 📐 CONTRACT：读写 /api/system-config 的 imaClientId / imaApiKey；测试走 /api/ima/test（服务端代发，浏览器不直连 ima）。
 * 🔗 RELATED：src/lib/ima.ts；知识仓库页「ima 知识库」栏；课堂编辑「引用 ima 知识库」。
 */
import { useEffect, useState } from "react";
import { Button, Input, MessagePlugin } from "tdesign-react";

export default function ImaSettingsCard() {
  const [expanded, setExpanded] = useState(false);
  const [clientId, setClientId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("token");
    fetch("/api/system-config", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (!c) return;
        setClientId(c.imaClientId || "");
        setApiKey(c.imaApiKey || "");
      })
      .catch(() => {});
  }, []);

  const configured = Boolean(clientId.trim() && apiKey.trim());

  const save = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch("/api/system-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ imaClientId: clientId.trim(), imaApiKey: apiKey.trim() }),
      });
      if (res.ok) MessagePlugin.success(clientId.trim() && apiKey.trim() ? "ima 凭证已保存" : "已解除 ima 对接");
      else MessagePlugin.error((await res.json().catch(() => ({}))).error || "保存失败");
    } catch {
      MessagePlugin.error("网络错误");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!configured) {
      MessagePlugin.warning("请先填写 Client ID 和 API Key");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch("/api/ima/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ clientId: clientId.trim(), apiKey: apiKey.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setTestResult({
          ok: true,
          text: `连接成功，共 ${data.count} 个知识库${data.names?.length ? `：${data.names.join("、")}${data.count > data.names.length ? "…" : ""}` : ""}`,
        });
      } else {
        setTestResult({ ok: false, text: `连接失败：${data.error || res.status}` });
      }
    } catch {
      setTestResult({ ok: false, text: "网络错误" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-[var(--card-border)] overflow-hidden">
      <div
        className="flex items-center justify-between px-6 py-4 cursor-pointer hover:bg-[var(--hover-bg)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <svg className="w-5 h-5 text-[var(--muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
          </svg>
          <span className="font-medium text-[var(--foreground)]">ima 知识库</span>
          <span className={`text-xs px-2 py-0.5 rounded ${configured ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-500"}`}>
            {configured ? "已配置" : "未配置"}
          </span>
        </div>
        <svg
          className={`w-5 h-5 text-[var(--muted-light)] transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </div>
      {expanded && (
        <div className="px-6 pb-6 border-t border-[var(--card-border)] space-y-4 pt-4">
          <div className="text-xs text-[var(--muted)] bg-[var(--hover-bg)] rounded-lg p-3 leading-relaxed">
            对接腾讯 ima 后，可在「知识仓库」浏览、搜索 ima 知识库，并在课堂里直接引用：学生提问时系统会实时检索 ima
            知识库，把相关片段交给 AI 参考。
            <br />
            获取方式：登录 <a className="text-[var(--primary)] underline" href="https://ima.qq.com/agent-interface" target="_blank" rel="noreferrer">ima.qq.com/agent-interface</a>
            ，复制 Client ID 和 API Key（API Key 只显示一次，请妥善保存）。凭证只保存在本机服务器，仅用于访问 ima 官方接口。
          </div>
          <div>
            <label className="block text-sm text-[var(--muted)] mb-1">Client ID</label>
            <Input value={clientId} onChange={(v) => setClientId(String(v))} placeholder="ima 开放接口的 Client ID" clearable />
          </div>
          <div>
            <label className="block text-sm text-[var(--muted)] mb-1">API Key</label>
            {/* TDesign 的 password 输入框自带「眼睛」切换显示，不要再加自定义按钮 */}
            <Input type="password" value={apiKey} onChange={(v) => setApiKey(String(v))} placeholder="ima 开放接口的 API Key" />
          </div>
          {testResult && (
            <div className={`text-sm ${testResult.ok ? "text-green-600" : "text-[var(--danger,#d54941)]"}`}>{testResult.text}</div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" loading={testing} onClick={test}>测试连接</Button>
            <Button theme="primary" loading={saving} onClick={save}>保存</Button>
          </div>
        </div>
      )}
    </div>
  );
}
