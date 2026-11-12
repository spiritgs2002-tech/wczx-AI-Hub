"use client";

/**
 * 知识仓库 →「ima 知识库」栏：浏览 / 搜索老师在腾讯 ima 里的知识库。
 * 📐 CONTRACT：只调用本站 /api/ima/*（服务端代发）；未配置凭证时引导去系统设置。
 * ⚠️ GOTCHA：ima 接口没有「读全文」，这里只能看条目标题和搜索片段；课堂引用后学生提问时实时检索（见 src/lib/ima.ts）。
 * 🔗 RELATED：src/components/settings/ImaSettingsCard.tsx；课堂编辑「引用 ima 知识库」。
 */
import { useEffect, useState } from "react";
import { Button, Card, Input, MessagePlugin } from "tdesign-react";

type Kb = { id: string; name: string };
type Item =
  | { kind: "file"; media_id: string; title: string }
  | { kind: "folder"; folder_id: string; name: string; file_number?: number };
type Hit = { title: string; snippet: string };

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem("token")}` });

export default function ImaKnowledgePanel() {
  const [state, setState] = useState<"loading" | "unconfigured" | "error" | "ready">("loading");
  const [error, setError] = useState("");
  const [kbs, setKbs] = useState<Kb[]>([]);
  const [active, setActive] = useState<Kb | null>(null);
  const [folderStack, setFolderStack] = useState<{ id: string; name: string }[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState("");
  const [isEnd, setIsEnd] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const loadKbs = async () => {
    setState("loading");
    const res = await fetch("/api/ima/knowledge-bases", { headers: authHeaders() }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (res?.ok) {
      setKbs(data.knowledgeBases || []);
      setState("ready");
    } else if (data.code === "IMA_NOT_CONFIGURED") {
      setState("unconfigured");
    } else {
      setError(data.error || "无法连接 ima");
      setState("error");
    }
  };

  useEffect(() => {
    void loadKbs();
  }, []);

  const loadItems = async (kb: Kb, folderId?: string, more = false) => {
    setLoadingItems(true);
    const params = new URLSearchParams({ kbId: kb.id });
    if (folderId) params.set("folderId", folderId);
    if (more && cursor) params.set("cursor", cursor);
    const res = await fetch(`/api/ima/items?${params}`, { headers: authHeaders() }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    setLoadingItems(false);
    if (!res?.ok) {
      MessagePlugin.error(data.error || "读取 ima 知识库失败");
      return;
    }
    setItems((prev) => (more ? [...prev, ...(data.items || [])] : data.items || []));
    setCursor(data.nextCursor || "");
    setIsEnd(data.isEnd !== false);
  };

  const openKb = (kb: Kb) => {
    setActive(kb);
    setFolderStack([]);
    setHits(null);
    setQuery("");
    void loadItems(kb);
  };

  const openFolder = (id: string, name: string) => {
    if (!active) return;
    setFolderStack((s) => [...s, { id, name }]);
    void loadItems(active, id);
  };

  const goUp = (index: number) => {
    if (!active) return;
    const next = folderStack.slice(0, index);
    setFolderStack(next);
    void loadItems(active, next.at(-1)?.id);
  };

  const search = async () => {
    if (!active || !query.trim()) return;
    setSearching(true);
    const res = await fetch(`/api/ima/search?kbId=${encodeURIComponent(active.id)}&q=${encodeURIComponent(query.trim())}`, {
      headers: authHeaders(),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    setSearching(false);
    if (!res?.ok) {
      MessagePlugin.error(data.error || "搜索失败");
      return;
    }
    setHits(data.hits || []);
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold text-[var(--title)]">🔗 ima 知识库</h3>
        {state === "ready" && <Button size="small" variant="text" onClick={loadKbs}>刷新</Button>}
      </div>

      {state === "loading" && <div className="text-sm text-[var(--muted-light)] py-6 text-center">正在读取 ima 知识库…</div>}
      {state === "unconfigured" && (
        <div className="text-sm text-[var(--muted)] py-6 text-center">
          尚未对接 ima。请到 <a className="text-[var(--primary)] underline" href="/teacher/settings">系统设置 → ima 知识库</a> 填写 Client ID 和 API Key。
        </div>
      )}
      {state === "error" && (
        <div className="text-sm text-[var(--danger,#d54941)] py-6 text-center">
          {error} <Button size="small" variant="text" onClick={loadKbs}>重试</Button>
        </div>
      )}

      {state === "ready" && (
        <div className="grid gap-4 md:grid-cols-[220px_1fr]">
          <div className="space-y-1 max-h-[420px] overflow-auto">
            {kbs.length === 0 && <div className="text-sm text-[var(--muted-light)]">ima 账号里还没有知识库</div>}
            {kbs.map((kb) => (
              <div
                key={kb.id}
                onClick={() => openKb(kb)}
                className={`px-3 py-2 rounded-lg cursor-pointer text-sm truncate ${active?.id === kb.id ? "bg-[var(--primary-light)] text-[var(--primary)] font-medium" : "hover:bg-[var(--hover-bg)]"}`}
                title={kb.name}
              >
                📘 {kb.name}
              </div>
            ))}
          </div>

          <div className="min-h-[200px]">
            {!active ? (
              <div className="text-sm text-[var(--muted-light)] py-8 text-center">点击左侧知识库查看内容；课堂中可在「编辑课堂 → 引用知识库」里直接选择 ima 知识库</div>
            ) : (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <Input
                    value={query}
                    onChange={(v) => setQuery(String(v))}
                    onEnter={search}
                    placeholder={`在「${active.name}」中搜索（预览学生提问时 AI 能检索到的内容）`}
                    clearable
                    onClear={() => setHits(null)}
                  />
                  <Button loading={searching} onClick={search}>搜索</Button>
                </div>

                {hits ? (
                  <div className="space-y-2">
                    <div className="text-xs text-[var(--muted)]">搜索结果 {hits.length} 条</div>
                    {hits.map((h, i) => (
                      <div key={i} className="p-3 rounded-lg border border-[var(--card-border)]">
                        <div className="text-sm font-medium">{h.title || "（无标题）"}</div>
                        {h.snippet && <div className="text-xs text-[var(--muted)] mt-1 line-clamp-3">{h.snippet}</div>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <>
                    <div className="text-xs text-[var(--muted)] flex flex-wrap gap-1">
                      <span className="cursor-pointer text-[var(--primary)]" onClick={() => goUp(0)}>{active.name}</span>
                      {folderStack.map((f, i) => (
                        <span key={f.id}>
                          {" / "}
                          <span className="cursor-pointer text-[var(--primary)]" onClick={() => goUp(i + 1)}>{f.name}</span>
                        </span>
                      ))}
                    </div>
                    <div className="space-y-1">
                      {items.map((it) =>
                        it.kind === "folder" ? (
                          <div key={it.folder_id} className="text-sm px-2 py-1.5 rounded hover:bg-[var(--hover-bg)] cursor-pointer" onClick={() => openFolder(it.folder_id, it.name)}>
                            📁 {it.name} <span className="text-xs text-[var(--muted-light)]">{it.file_number ?? 0} 个文件</span>
                          </div>
                        ) : (
                          <div key={it.media_id} className="text-sm px-2 py-1.5">📄 {it.title}</div>
                        ),
                      )}
                      {!loadingItems && items.length === 0 && <div className="text-sm text-[var(--muted-light)]">这里还没有内容</div>}
                      {loadingItems && <div className="text-sm text-[var(--muted-light)]">加载中…</div>}
                      {!isEnd && !loadingItems && (
                        <Button size="small" variant="text" onClick={() => loadItems(active, folderStack.at(-1)?.id, true)}>加载更多</Button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <p className="text-xs text-[var(--muted)] mt-3">
        说明：ima 知识库内容保存在腾讯 ima 中，本平台不复制全文；课堂引用后，学生每次提问时系统实时检索相关片段交给 AI 参考（不占 50,000 字符额度）。
      </p>
    </Card>
  );
}
