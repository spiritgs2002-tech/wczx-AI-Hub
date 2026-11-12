"use client";

/**
 * 麦克风测试页（/mic-test，无需登录、不上传任何数据）
 *
 * 为什么：学生平板录音"声音很杂"无法在电脑上复现（2026-11-12）。一次录音同时产出 4 个版本放在同一页试听，
 *   老师在平板上逐个听就能判断问题出在哪一环：
 *   A 原始采样率 PCM（未重采样）       —— A 就杂 ⇒ 麦克风/浏览器音频处理/环境问题，与本系统转码无关
 *   B PCM → 16kHz（PCM 兜底通道）      —— A 好 B 杂 ⇒ 重采样问题
 *   C 浏览器压缩录音原文件              —— C 好 A 杂 ⇒ 主线程 ScriptProcessor 丢缓冲
 *   D 压缩录音 → 16kHz（当前发给 AI 的版本）
 *   另可勾选「关闭浏览器降噪/自动增益」再录一次，判断是否浏览器自带处理引入失真。
 * 现状：纯前端，录音只存在于本页内存；页面离开即释放麦克风。
 * 🔗 RELATED：src/app/student/chat/page.tsx toggleRecording（正式录音链路，顺序为压缩优先、PCM 兜底）；src/lib/audio/wav.ts。
 * ⛔ DO NOT 在本页上传或保存录音 —— 它是排查工具，不应产生学生数据。
 */
import { useEffect, useRef, useState } from "react";
import { encodeWav, mixToMono, resample, TARGET_SAMPLE_RATE } from "@/lib/audio/wav";

type Version = { key: string; title: string; hint: string; url: string; info: string };

const peakOf = (x: Float32Array) => {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
};
const wavUrl = (pcm: Float32Array, rate: number) =>
  URL.createObjectURL(new Blob([encodeWav(pcm, Math.round(rate))], { type: "audio/wav" }));

export default function MicTestPage() {
  const [recording, setRecording] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [status, setStatus] = useState("");
  const [settings, setSettings] = useState("");
  const stopRef = useRef<(() => void) | null>(null);
  const urlsRef = useRef<string[]>([]);

  useEffect(() => () => {
    stopRef.current?.();
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const start = async () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setStatus(`当前地址 ${location.origin} 不是 HTTPS，浏览器禁止使用麦克风。请用班级二维码里的 https 地址打开本页（把路径改成 /mic-test）。`);
      return;
    }
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    urlsRef.current = [];
    setVersions([]);
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
      setStatus("当前浏览器不支持 Web Audio");
      return;
    }
    const ctx = new Ctx();
    void ctx.resume().catch(() => {});
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: rawMode ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : true,
      });
    } catch (e) {
      void ctx.close();
      setStatus(`无法打开麦克风：${(e as Error)?.name || e}`);
      return;
    }
    const track = stream.getAudioTracks()[0];
    const st = (track?.getSettings?.() || {}) as MediaTrackSettings;
    setSettings(
      `采样率 ${st.sampleRate ?? "?"}Hz｜回声消除 ${st.echoCancellation ?? "?"}｜降噪 ${st.noiseSuppression ?? "?"}｜自动增益 ${st.autoGainControl ?? "?"}｜${navigator.userAgent.match(/(Firefox|EdgA?|Chrome|Version)\/[\d.]+/)?.[0] || ""}`,
    );

    const pcm: Float32Array[] = [];
    let pcmRate = ctx.sampleRate;
    let cleanupPcm = () => {};
    try {
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      proc.onaudioprocess = (e) => {
        pcmRate = e.inputBuffer.sampleRate;
        pcm.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      cleanupPcm = () => {
        proc.onaudioprocess = null;
        src.disconnect();
        proc.disconnect();
        mute.disconnect();
      };
    } catch {
      // PCM 不可用时只出压缩版本
    }

    const chunks: Blob[] = [];
    let recorder: MediaRecorder | null = null;
    const recDone = new Promise<void>((resolve) => {
      try {
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        recorder.onstop = () => resolve();
        recorder.start(1000);
      } catch {
        resolve();
      }
    });

    setRecording(true);
    setStatus("录音中…说一两句话后点「停止」");
    stopRef.current = () => {
      stopRef.current = null;
      setRecording(false);
      cleanupPcm();
      const r = recorder as MediaRecorder | null;
      if (r && r.state !== "inactive") r.stop();
      void (async () => {
        await Promise.race([recDone, new Promise((res) => setTimeout(res, 3000))]);
        stream.getTracks().forEach((t) => t.stop());
        const out: Version[] = [];
        const total = pcm.reduce((n, c) => n + c.length, 0);
        if (total) {
          const all = new Float32Array(total);
          let o = 0;
          for (const c of pcm) { all.set(c, o); o += c.length; }
          const a = wavUrl(all, pcmRate);
          const b = wavUrl(resample(all, pcmRate, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
          urlsRef.current.push(a, b);
          out.push({ key: "A", title: "A 原始声音（未压缩）", hint: "如果 A 就杂：问题在麦克风、浏览器或环境", url: a, info: `${pcmRate}Hz，峰值 ${peakOf(all).toFixed(3)}` });
          out.push({ key: "B", title: "B 原始声音 → 16kHz", hint: "A 好 B 杂：转换采样率出了问题", url: b, info: "PCM 兜底通道" });
        }
        if (chunks.length) {
          const blob = new Blob(chunks, { type: (recorder as MediaRecorder | null)?.mimeType || chunks[0].type });
          const c = URL.createObjectURL(blob);
          urlsRef.current.push(c);
          out.push({ key: "C", title: "C 浏览器压缩录音（原文件）", hint: "C 好 A 杂：页面卡顿导致原始通道丢数据", url: c, info: `${blob.type}，${Math.round(blob.size / 1024)}KB` });
          try {
            const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
            const mono = mixToMono(Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i)));
            const d = wavUrl(resample(mono, decoded.sampleRate, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
            urlsRef.current.push(d);
            out.push({ key: "D", title: "D 压缩录音 → 16kHz（现在发给 AI 的版本）", hint: "C 好 D 杂：解码或转换出了问题", url: d, info: `峰值 ${peakOf(mono).toFixed(3)}` });
          } catch (e) {
            out.push({ key: "D", title: "D 压缩录音 → 16kHz", hint: "解码失败（此浏览器正式录音会改用 B）", url: "", info: String((e as Error)?.name || e) });
          }
        }
        void ctx.close();
        setVersions(out);
        setStatus(out.length ? "录好了，请逐个播放对比，告诉老师/开发者哪几个杂、哪几个清楚。" : "没有录到任何数据");
      })();
    };
  };

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: 20, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>麦克风测试</h1>
      <p style={{ color: "#666", fontSize: 14, marginBottom: 16 }}>
        录一次，生成 4 个版本，逐个播放听哪个杂、哪个清楚。录音只在本页，不会上传。
      </p>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, marginBottom: 16 }}>
        <input type="checkbox" checked={rawMode} disabled={recording} onChange={(e) => setRawMode(e.target.checked)} />
        关闭浏览器自带的降噪 / 自动增益 / 回声消除（对比用）
      </label>
      <button
        onClick={() => (recording ? stopRef.current?.() : void start())}
        style={{ padding: "12px 28px", fontSize: 18, borderRadius: 8, border: 0, color: "#fff", background: recording ? "#D54941" : "#0052D9" }}
      >
        {recording ? "停止" : "开始录音"}
      </button>
      {status && <p style={{ marginTop: 16, fontSize: 14 }}>{status}</p>}
      {settings && <p style={{ marginTop: 4, fontSize: 12, color: "#888" }}>{settings}</p>}
      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        {versions.map((v) => (
          <div key={v.key} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
            <div style={{ fontWeight: 600 }}>{v.title}</div>
            <div style={{ fontSize: 12, color: "#888", margin: "4px 0 8px" }}>{v.info}｜{v.hint}</div>
            {v.url ? <audio controls src={v.url} style={{ width: "100%" }} /> : <span style={{ fontSize: 13, color: "#D54941" }}>无法生成</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
