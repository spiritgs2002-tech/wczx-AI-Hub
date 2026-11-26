"use client";

import { useEffect, useState } from "react";
import { Button, Dialog, Input, InputNumber, MessagePlugin, Select, Textarea, Transfer } from "tdesign-react";
import type { GroupInput, GroupMode, GroupStudent } from "@/lib/groups/grouping";

type GroupData = {
  classId: string | null;
  className: string | null;
  classes: { id: string; name: string }[];
  students: GroupStudent[];
  groups: GroupInput[];
};

async function groupRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem("token") || "";
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "分组操作失败");
  return data;
}

// MUST KEEP PREVIEW LOCAL: 生成预览只替换当前草稿，明确保存才写入当前班级。
// 📐 CONTRACT: 成员选项来自 GET 班级名单；🔗 RELATED: groups/route.ts、groups/auto/route.ts。
// ⛔ DO NOT REVERT: 浏览器不读取任何学生凭据或个人答卷。
export default function GroupManagerDialog({ taskId, taskTitle, visible, onClose, onSaved }: {
  taskId: string;
  taskTitle: string;
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [classId, setClassId] = useState<string>();
  const [data, setData] = useState<GroupData | null>(null);
  const [groups, setGroups] = useState<GroupInput[]>([]);
  const [mode, setMode] = useState<GroupMode>("BALANCED");
  const [groupCount, setGroupCount] = useState(10);
  const [pending, setPending] = useState<"preview" | "save" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const url = `/api/tasks/${encodeURIComponent(taskId)}/groups`;

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setData(null);
    groupRequest<GroupData>(url + (classId ? `?classId=${encodeURIComponent(classId)}` : ""), { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setData(result); setGroups(result.groups); } })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [url, classId, visible]);

  const updateGroup = (index: number, patch: Partial<GroupInput>) =>
    setGroups((items) => items.map((group, i) => i === index ? { ...group, ...patch } : group));

  async function submit(action: "preview" | "save") {
    if (!data?.classId || loading || pending) return;
    setPending(action);
    setError("");
    try {
      if (action === "preview") {
        const draft = await groupRequest<{ groups: GroupInput[] }>(`${url}/auto`, {
          method: "POST", body: JSON.stringify({ classId: data.classId, mode, groupCount }),
        });
        const savedIds = new Map(data.groups.map((group) => [group.name, group.id]));
        setGroups(draft.groups.map((group) => ({ ...group, id: savedIds.get(group.name) })));
        MessagePlugin.success("已生成预览，保存后学生可见");
      } else {
        await groupRequest(url, { method: "POST", body: JSON.stringify({ classId: data.classId, groups }) });
        MessagePlugin.success("分组已保存");
        onSaved();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "分组操作失败");
    } finally {
      setPending(null);
    }
  }

  const busy = loading || pending !== null;
  const roster = data?.students.map(({ id, name, studentNo }) => ({ value: id, label: studentNo ? `${studentNo} · ${name}` : name })) ?? [];
  const assigned = new Set(groups.flatMap((group) => group.memberIds));
  return (
    <Dialog width={760} header={`分组管理 · ${taskTitle}`} visible={visible} footer={null}
      closeOnOverlayClick={false} closeOnEscKeydown={false} onClose={() => { if (!pending) onClose(); }}>
      <div className="space-y-4">
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {loading && <p role="status" className="text-sm text-[var(--muted)]">正在加载班级分组…</p>}
        {data && !data.classId && <p className="text-sm text-[var(--muted)]">请先为课堂分配班级。</p>}
        {data?.classId && <>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-[var(--muted)]">班级</span>
            {data.classes.length > 1 ? <Select value={data.classId} disabled={busy}
              options={data.classes.map(({ id, name }) => ({ value: id, label: name }))}
              onChange={(value) => setClassId(String(value))} /> : <span>{data.className}</span>}
            <span className="text-sm text-[var(--muted)]">共 {roster.length} 人 · 未分组 {roster.filter(({ value }) => !assigned.has(value)).length} 人</span>
          </div>
          <div className="flex flex-wrap items-center gap-3 rounded p-3 bg-[var(--primary-light)]">
            <Select value={mode} disabled={busy} options={[
              { value: "BALANCED", label: "蛇形均分" }, { value: "BY_NO", label: "按学号分组" }, { value: "BY_SCORE", label: "按作业得分分层" },
            ]} onChange={(value) => setMode(value as GroupMode)} />
            <label className="flex items-center gap-2 text-sm">组数
              <InputNumber value={groupCount} min={2} max={30} step={1} disabled={busy} onChange={(value) => setGroupCount(Number(value))} />
            </label>
            <Button variant="outline" disabled={busy} loading={pending === "preview"} onClick={() => void submit("preview")}>生成预览</Button>
          </div>
          <div className="max-h-[50vh] space-y-3 overflow-y-auto">
            {groups.map((group, index) => <details key={group.id ?? index} className="rounded border border-gray-200 p-3">
              <summary className="cursor-pointer text-sm">{group.name || `第${index + 1}组`} · {group.memberIds.length} 人{group.tier ? ` · ${group.tier}` : ""}</summary>
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-sm">组名<Input value={group.name} maxlength={40} disabled={busy} onChange={(name) => updateGroup(index, { name })} /></label>
                  <label className="text-sm">层级<Input value={group.tier ?? ""} maxlength={20} disabled={busy} onChange={(tier) => updateGroup(index, { tier })} /></label>
                </div>
                <label className="block text-sm">任务要求<Textarea value={group.taskBrief ?? ""} maxlength={1000} disabled={busy} onChange={(taskBrief) => updateGroup(index, { taskBrief })} /></label>
                <div className="overflow-x-auto">
                  <Transfer data={roster} value={group.memberIds} title={["本班学生", "本组成员"]} search disabled={busy}
                    onChange={(ids) => updateGroup(index, { memberIds: ids.map(String) })} />
                </div>
                <Button theme="danger" variant="text" size="small" disabled={busy} onClick={() => setGroups((items) => items.filter((_, i) => index !== i))}>移除此组</Button>
              </div>
            </details>)}
          </div>
          <div className="flex justify-between">
            <Button variant="outline" disabled={busy || groups.length >= 30} onClick={() => {
              const names = new Set(groups.map(({ name }) => name.trim()));
              let number = 1;
              while (names.has(`第${number}组`)) number++;
              setGroups([...groups, { name: `第${number}组`, memberIds: [] }]);
            }}>添加小组</Button>
            <Button theme="primary" disabled={busy || !groups.length} loading={pending === "save"} onClick={() => void submit("save")}>保存分组</Button>
          </div>
        </>}
      </div>
    </Dialog>
  );
}
