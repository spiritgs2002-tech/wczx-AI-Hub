// MUST KEEP THESE CHECKS IN SYNC: 音频改动必须同时检查频响、边界与 WAV 字节，避免只听感验收。
// 📐 CONTRACT: node scripts/test-audio.mjs；失败退出非 0，固定版本 esbuild 临时安装/复用 npm 缓存，不改仓库依赖。
// 🔗 RELATED: src/lib/audio/wav.ts；src/app/student/chat/page.tsx 的双通道录音与附件转码。
// ⛔ DO NOT REVERT: 不以含首尾瞬态的全段 RMS 测阻带；边界另测，频响取稳态区间。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "wczx-audio-"));
try {
  // --source 允许同一套测量在 git show 导出的基线上运行，便于比较算法修改前后。
  const source = process.argv[2] === "--source" ? resolve(process.argv[3]) : join(root, "src/lib/audio/wav.ts");
  const bundle = join(temporary, "wav.mjs");
  execFileSync("npx", ["--yes", "--package=esbuild@0.25.12", "esbuild", source,
    "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`], { cwd: root, stdio: "pipe" });
  const { resample, mixToMono, encodeWav } = await import(pathToFileURL(bundle).href);
  let count = 0;
  const test = (name, run) => {
    run();
    count++;
    console.log(`PASS ${name}`);
  };
  const sine = (rate, hz, length = rate) => Float32Array.from({ length }, (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * i / rate));
  const rms = (pcm, skip) => {
    let energy = 0;
    for (let i = skip; i < pcm.length - skip; i++) energy += pcm[i] ** 2;
    return Math.sqrt(energy / (pcm.length - 2 * skip));
  };
  const gain = (srcRate, dstRate, hz) => {
    const output = resample(sine(srcRate, hz), srcRate, dstRate);
    const db = 20 * Math.log10(rms(output, Math.ceil(dstRate * 0.05)) / (0.5 / Math.sqrt(2)));
    console.log(`  ${srcRate}→${dstRate} ${hz}Hz: ${db.toFixed(3)}dB`);
    return db;
  };
  for (const srcRate of [48000, 44100]) {
    for (const hz of [1000, 3000]) test(`通带 ${srcRate}→16000 ${hz}Hz ±0.1dB`, () => {
      assert.ok(Math.abs(gain(srcRate, 16000, hz)) < 0.1);
    });
    for (const hz of [9000, 12000]) test(`阻带 ${srcRate}→16000 ${hz}Hz ≤-60dB`, () => {
      assert.ok(gain(srcRate, 16000, hz) <= -60);
    });
  }
  for (const [src, dst] of [[48000, 16000], [44100, 16000], [44100, 8000], [8000, 16000], [16000, 44100], [16000, 16000]]) {
    test(`长度/短输入/DC ${src}→${dst}`, () => {
      // 📐 CONTRACT: 非空输入至少保留一个样本，其余长度向下取整；空输入仍为空。
      for (const length of [0, 1, 2, 3, 17, 1001, src]) {
        const input = new Float32Array(length).fill(0.25);
        const out = resample(input, src, dst);
        assert.equal(out.length, length ? Math.max(1, Math.floor(length / (src / dst))) : 0);
        assert.notEqual(out, input);
        for (const sample of out) {
          assert.ok(Number.isFinite(sample));
          assert.ok(Math.abs(sample - 0.25) < 1e-6, `DC ${sample}`);
        }
        assert.ok(resample(new Float32Array(length), src, dst).every((v) => v === 0));
      }
    });
  }
  for (const [src, dst] of [[44100, 8000], [8000, 16000], [16000, 44100]]) {
    test(`非整数倍/升采样幅度与相位 ${src}→${dst}`, () => {
      const hz = 1000;
      assert.ok(Math.abs(gain(src, dst, hz)) < 0.1);
      const out = resample(sine(src, hz), src, dst);
      const skip = Math.ceil(dst * 0.05);
      let err = 0;
      for (let i = skip; i < out.length - skip; i++) err += (out[i] - 0.5 * Math.sin(2 * Math.PI * hz * i / dst)) ** 2;
      assert.ok(Math.sqrt(err / (out.length - 2 * skip)) < 0.002);
    });
  }
  test("WAV RIFF/fmt/data、采样率、长度及 16bit 饱和编码", () => {
    for (const rate of [8000, 16000, 44100]) for (const pcm of [new Float32Array(), new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2])]) {
      const bytes = encodeWav(pcm, rate);
      const view = new DataView(bytes);
      const str = (start, len) => String.fromCharCode(...new Uint8Array(bytes, start, len));
      assert.equal(bytes.byteLength, 44 + pcm.length * 2);
      assert.equal(str(0, 4), "RIFF");
      assert.equal(view.getUint32(4, true), bytes.byteLength - 8);
      assert.equal(str(8, 4), "WAVE");
      assert.equal(str(12, 4), "fmt ");
      assert.equal(view.getUint32(16, true), 16);
      assert.equal(view.getUint16(20, true), 1);
      assert.equal(view.getUint16(22, true), 1);
      assert.equal(view.getUint32(24, true), rate);
      assert.equal(view.getUint32(28, true), rate * 2);
      assert.equal(view.getUint16(32, true), 2);
      assert.equal(view.getUint16(34, true), 16);
      assert.equal(str(36, 4), "data");
      assert.equal(view.getUint32(40, true), pcm.length * 2);
      if (pcm.length) assert.deepEqual(Array.from({ length: pcm.length }, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, -32768, -16384, 0, 16383, 32767, 32767]);
    }
  });
  test("多声道平均、反相抵消、空输入及单声道复制", () => {
    const left = new Float32Array([1, -1, 0.5]);
    assert.deepEqual([...mixToMono([left, new Float32Array([-1, 1, -0.5])])], [0, 0, 0]);
    assert.deepEqual([...mixToMono([left, left, new Float32Array(3)])], [2 / 3, -2 / 3, 1 / 3].map(Math.fround));
    assert.deepEqual([...mixToMono([])], []);
    assert.deepEqual(mixToMono([left]), left);
    assert.notEqual(mixToMono([left]), left);
    assert.deepEqual([...left], [1, -1, 0.5]);
  });
  test("拒绝非法采样率与不等长声道", () => {
    for (const rate of [0, -1, NaN, Infinity]) {
      assert.throws(() => resample(new Float32Array(1), rate, 16000), RangeError);
      assert.throws(() => resample(new Float32Array(), 16000, rate), RangeError);
      assert.throws(() => encodeWav(new Float32Array(), rate), RangeError);
    }
    for (const rate of [1.5, 2 ** 32]) assert.throws(() => encodeWav(new Float32Array(), rate), RangeError);
    assert.throws(() => mixToMono([new Float32Array(1), new Float32Array(2)]), RangeError);
  });

  // MUST TEST THE REAL HANDLERS: 用 TypeScript AST 提取实际录音闭包，避免复制一份实现而测不到回归。
  // 📐 CONTRACT: 浏览器 API 用可控替身验证生命周期/竞态，不等同于 iPad 或安卓硬件验收。
  // 🔗 RELATED: student/chat/page.tsx 的会话锁、cleanup 和 switchTo*；⛔ DO NOT REVERT 成只检查源码关键词。
  const require = createRequire(import.meta.url);
  const ts = require("typescript");
  const page = ts.createSourceFile("page.tsx", await readFile(join(root, "src/app/student/chat/page.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["decodeAudio", "closeAudioContext", "cancelRecording", "MAX_RECORD_SEC", "SILENCE_PEAK", "peakOf", "toggleRecording"];
  const pieces = new Map();
  let lifecycle;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(page))) pieces.set(node.name.getText(page), `const ${node.getText(page)};`);
    if (ts.isCallExpression(node) && node.expression.getText(page) === "useEffect" && node.getText(page).includes('"pagehide"')) lifecycle = node.getText(page);
    ts.forEachChild(node, visit);
  };
  visit(page);
  assert.equal(pieces.size, names.length, "录音函数变更后需同步测试提取入口");
  assert.ok(lifecycle);
  const harnessSource = join(temporary, "recording.ts");
  const harnessBundle = join(temporary, "recording.mjs");
  await writeFile(harnessSource, `export function createHarness(env) {
    const {window,navigator,MediaRecorder,Date,setTimeout,clearTimeout,setInterval,clearInterval,MessagePlugin,pcmToWavDataUrl,mixToMono} = env;
    const stopRecordingRef = {current:null}, audioSelectionRef = {current:0};
    const activePresetId = "activity-a", activeConvId = "conversation-a", activeType = "chat";
    const state = {isRecording:false,sec:0,audio:null};
    const setIsRecording = v => {state.isRecording = v;};
    const setRecordingSec = v => {state.sec = typeof v === "function" ? v(state.sec) : v;};
    const setPendingAudio = v => {state.audio = v;};
    let cleanup; const useEffect = fn => {cleanup = fn();};
    ${names.map(name => pieces.get(name)).join("\n")}
    ${lifecycle};
    return {toggleRecording,cancelRecording,state,cleanup,stopRecordingRef};
  }`);
  execFileSync("npx", ["--yes", "--package=esbuild@0.25.12", "esbuild", harnessSource,
    "--bundle", "--platform=node", "--format=esm", `--outfile=${harnessBundle}`], { cwd: root, stdio: "pipe" });
  const { createHarness } = await import(pathToFileURL(harnessBundle).href);
  const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const fixture = (options = {}) => {
    let now = 0, requests = 0, nextTimer = 0;
    const permission = deferred(), encoded = deferred();
    const timers = new Map(), events = new Map(), contexts = [], recorders = [], encodes = [], notices = [];
    const track = { readyState: "live", muted: false, enabled: true, stops: 0,
      stop() { this.readyState = "ended"; this.stops++; }, getSettings: () => ({ sampleRate: 48000 }) };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    class AudioCtx {
      state = "running"; sampleRate = 44100; closes = 0; nodes = [];
      constructor() { contexts.push(this); }
      resume() { return options.resumePending ? new Promise(() => {}) : Promise.resolve(); }
      close() { this.closes++; this.state = "closed"; return Promise.resolve(); }
      node() { const node = { connect() {}, disconnect() { this.disconnected = true; }, gain: { value: 1 } }; this.nodes.push(node); return node; }
      createMediaStreamSource() { if (options.sourceFails) throw new Error("mismatched Firefox rates"); return this.node(); }
      createScriptProcessor() { this.proc = this.node(); return this.proc; }
      createGain() { return this.node(); }
      decodeAudioData(data, success) {
        const result = { sampleRate: 16000, numberOfChannels: 2, getChannelData: i => new Float32Array([i ? 0.5 : 0, i ? 0.5 : 0]) };
        queueMicrotask(() => success(result));
        return options.callbackOnly ? undefined : Promise.resolve(result);
      }
    }
    class Recorder {
      static isTypeSupported(type) { return type === (options.mime || "audio/webm;codecs=opus"); }
      state = "inactive"; stops = 0;
      constructor(stream, config) { this.mimeType = config?.mimeType || "audio/mp4"; recorders.push(this); }
      start() { this.state = "recording"; }
      stop() {
        this.stops++; this.state = "inactive";
        if (!options.recorderHangs) queueMicrotask(() => {
          this.ondataavailable?.({ data: new Blob(["compressed"], { type: this.mimeType }) });
          this.onstop?.();
        });
      }
    }
    const timer = (fn, ms, repeating = false) => { const id = ++nextTimer; timers.set(id, { fn, ms, repeating }); return id; };
    const h = createHarness({
      window: { isSecureContext: true, webkitAudioContext: AudioCtx, location: { origin: "https://teacher:3443" },
        addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) },
      navigator: { userAgent: "Firefox/145.0", mediaDevices: { getUserMedia: () => { requests++; return permission.promise; } } },
      MediaRecorder: Recorder, Date: { now: () => now },
      setTimeout: (fn, ms) => timer(fn, ms), setInterval: (fn, ms) => timer(fn, ms, true),
      clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
      MessagePlugin: Object.fromEntries(["warning", "error"].map(key => [key, (...args) => notices.push(args)])),
      mixToMono, pcmToWavDataUrl: (pcm, rate) => { encodes.push({ pcm, rate }); return options.encodePending ? encoded.promise : Promise.resolve("data:audio/wav;base64,test"); },
    });
    return { h, permission, encoded, contexts, recorders, encodes, notices, timers, track, events,
      requests: () => requests,
      async start() { const pending = h.toggleRecording(); permission.resolve(stream); await pending; },
      grant() { permission.resolve(stream); },
      advance(ms) { now += ms; },
      pcm() { contexts.at(-1).proc.onaudioprocess({ inputBuffer: { sampleRate: 44100, getChannelData: () => new Float32Array([0.25, -0.25]) } }); },
      fire(ms) { const entry = [...timers].find(([, t]) => t.ms === ms); assert.ok(entry, `timer ${ms}`); const [id, t] = entry; if (!t.repeating) timers.delete(id); t.fn(); },
    };
  };
  const asyncTest = async (name, run) => { await run(); count++; console.log(`PASS ${name}`); };
  const released = (f) => {
    assert.equal(f.h.stopRecordingRef.current, null);
    assert.equal(f.timers.size, 0);
    assert.equal(f.contexts[0].closes, 1);
    assert.equal(f.track.readyState, "ended");
    assert.ok(f.contexts[0].nodes.every(n => n.disconnected));
    for (const r of f.recorders) assert.equal(r.ondataavailable, null);
  };
  await asyncTest("授权等待连点只申请一次；卸载后迟到麦克风立即释放", async () => {
    const f = fixture(); const pending = f.h.toggleRecording();
    await f.h.toggleRecording(); assert.equal(f.requests(), 1);
    f.h.cleanup(); f.grant(); await pending; released(f); assert.equal(f.encodes.length, 0);
  });
  await asyncTest("授权拒绝释放 context 与会话锁", async () => {
    const f = fixture(); const pending = f.h.toggleRecording();
    f.permission.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })); await pending;
    assert.equal(f.h.stopRecordingRef.current, null); assert.equal(f.contexts[0].closes, 1); assert.equal(f.notices.length, 1);
  });
  await asyncTest("手动/60秒同时停止只编码一次；处理期间连点不重开；PCM 使用实际时钟", async () => {
    const f = fixture({ encodePending: true, resumePending: true }); await f.start(); f.pcm(); f.advance(60000);
    const deadline = [...f.timers.values()].find(t => t.ms === 60000).fn;
    await f.h.toggleRecording(); deadline(); await f.h.toggleRecording();
    assert.equal(f.requests(), 1); assert.equal(f.recorders[0].stops, 1); assert.equal(f.encodes.length, 1);
    assert.equal(f.encodes[0].rate, 44100); assert.equal(f.track.readyState, "ended");
    f.encoded.resolve("wav"); await flush(); released(f); assert.equal(f.h.state.audio, "wav");
  });
  await asyncTest("转码中切活动丢弃旧结果；旧 finally 不关闭新会话", async () => {
    const f = fixture({ encodePending: true }); await f.start(); f.pcm(); f.advance(1000); await f.h.toggleRecording();
    f.h.cancelRecording(); await f.h.toggleRecording();
    f.encoded.resolve("stale"); await flush();
    assert.equal(f.h.state.audio, null); assert.equal(f.contexts[0].closes, 1); assert.equal(f.contexts[1].closes, 0);
    assert.ok(f.h.stopRecordingRef.current); f.h.cleanup(); assert.equal(f.contexts[1].closes, 1); assert.equal(f.timers.size, 0);
  });
  await asyncTest("webkitAudioContext + MP4 + 回调解码；PCM 建图失败走压缩混音", async () => {
    const f = fixture({ sourceFails: true, mime: "audio/mp4", callbackOnly: true }); await f.start(); f.advance(1000);
    await f.h.toggleRecording(); await flush(); released(f);
    assert.equal(f.recorders[0].mimeType, "audio/mp4"); assert.equal(f.encodes.length, 1);
    assert.deepEqual([...f.encodes[0].pcm], [0.25, 0.25]); assert.equal(f.encodes[0].rate, 16000);
  });
  await asyncTest("压缩停止超时释放全部计时器并拒发静音", async () => {
    const f = fixture({ recorderHangs: true }); await f.start(); f.advance(1000); await f.h.toggleRecording();
    f.fire(3000); await flush(); released(f); assert.equal(f.encodes.length, 0); assert.equal(f.notices.length, 1);
  });
  await asyncTest("页面离开在录音中立即释放；太短录音不挂附件", async () => {
    const f = fixture(); await f.start(); f.events.get("pagehide")(); released(f);
    assert.equal(f.h.state.isRecording, false); assert.equal(f.encodes.length, 0);
    const short = fixture(); await short.start(); await short.h.toggleRecording(); await flush(); released(short);
    assert.equal(short.encodes.length, 0); assert.equal(short.notices.length, 1);
  });
  console.log(`\n${count} audio tests passed`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
