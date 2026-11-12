/**
 * 浏览器端音频工具：带抗混叠滤波的重采样 + 16bit PCM WAV 编码（纯函数，浏览器与 Node 均可用）。
 *
 * 为什么不用 OfflineAudioContext 重采样：
 *   Chrome 用 AudioBufferSourceNode 播放不同采样率的 buffer 时只做线性插值、不做低通滤波。
 *   48kHz → 16kHz 时 8kHz 以上的成分（齿音 s/sh、麦克风底噪）会折叠回可听频段变成刺耳的"沙沙"杂音。
 *   🧪 MEASURED（2026-11-12，Chrome 152）：输入 12kHz 正弦，输出仅衰减 2.1dB（应被完全滤除）；
 *   平板实录语音 3–5kHz 能量占 42%（正常语音 <10%），学生反馈"声音很杂"。
 * 现状：窗函数 sinc（Blackman 窗）低通 + 分数位置插值，截止频率 = 0.45 × 目标采样率；
 *   60 秒 48k→16k 约 1 亿次乘加，平板上数百毫秒内完成。
 * ⛔ DO NOT REVERT 回 OfflineAudioContext / 线性插值重采样。
 * 🔗 RELATED：src/app/student/chat/page.tsx 的录音（toggleRecording）与选择音频文件（transcodeAudioToWav）都走这里。
 */

export const TARGET_SAMPLE_RATE = 16000;

// MUST VALIDATE THE CLOCK: 非法采样率会产生无限长度分配或无效 WAV 头；所有入口共用同一检查。
// 📐 CONTRACT: 采样率为有限正数，WAV 还要求整数；🔗 RELATED: resample / encodeWav、scripts/test-audio.mjs。
// ⛔ DO NOT REVERT: 不能把缺失采样率默认为 48kHz，否则 Firefox/iOS 的音频会变速。
const assertSampleRate = (rate: number) => {
  if (!Number.isFinite(rate) || rate <= 0) throw new RangeError("Sample rate must be finite and positive");
};

/**
 * MUST KEEP THE FILTER: Blackman sinc + 256 相位表；本次审查不改滤波算法或参数。
 * 📐 CONTRACT: 空输入为空；非空长度 max(1, floor(N / (srcRate / dstRate)))，同采样率返回独立副本。
 * 🧪 MEASURED: scripts/test-audio.mjs，48k→16k 的 1k/3k 为 0.000/0.001dB，9k/12k 为 -70.992/-88.456dB；
 *   44.1k→16k 的 9k/12k 为 -74.642/-95.369dB，短输入/DC、44.1k→8k 与升采样均通过。
 * 🔗 RELATED: scripts/test-audio.mjs 与 student/chat/page.tsx 的 PCM 实际采样率。
 * ⛔ DO NOT REVERT: 不用线性插值替换，不改边界权重归一化；改核或相位精度必须比较同一测试的前后频响。
 */
export function resample(input: Float32Array, srcRate: number, dstRate: number = TARGET_SAMPLE_RATE): Float32Array {
  assertSampleRate(srcRate);
  assertSampleRate(dstRate);
  if (!input.length || srcRate === dstRate) return new Float32Array(input);
  const ratio = srcRate / dstRate; // 每个输出样本对应的输入步长
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  // 截止频率（以输入采样率归一化，cycles/sample）：取目标 Nyquist 的 90%；升采样时以输入 Nyquist 为准
  const fc = 0.45 * Math.min(1, dstRate / srcRate);
  // 核半宽（输入样本数）：降采样倍数越大越宽，保证过渡带足够陡
  const half = Math.ceil(12 * Math.max(1, ratio));
  const taps = 2 * half; // 覆盖 floor(center)-half+1 … floor(center)+half
  // 多相系数表：按输出位置的小数部分量化成 PHASES 档预先算好（含归一化），内层循环只剩乘加。
  // 🧪 MEASURED（Mac, Node 22）：60 秒 48k→16k 未查表 1132ms → 查表 41ms；阻带衰减 9k/12k/20k = -71/-88/-113dB。
  const PHASES = 256;
  const table: Float32Array[] = new Array(PHASES + 1);
  const kernelFor = (p: number): Float32Array => {
    let h = table[p];
    if (h) return h;
    h = new Float32Array(taps);
    const frac = p / PHASES;
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const d = j - half + 1 - frac; // 输入样本相对 center 的偏移
      const x = 2 * fc * d;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const n = Math.max(-1, Math.min(1, d / half));
      const win = 0.42 + 0.5 * Math.cos(Math.PI * n) + 0.08 * Math.cos(2 * Math.PI * n); // Blackman
      h[j] = sinc * win;
      sum += h[j];
    }
    for (let j = 0; j < taps; j++) h[j] /= sum;
    table[p] = h;
    return h;
  };
  const last = input.length - 1;
  for (let i = 0; i < outLen; i++) {
    const center = i * ratio;
    const base = Math.floor(center);
    const h = kernelFor(Math.round((center - base) * PHASES));
    const k0 = base - half + 1;
    let acc = 0;
    if (k0 >= 0 && k0 + taps - 1 <= last) {
      for (let j = 0; j < taps; j++) acc += input[k0 + j] * h[j];
    } else {
      // 首尾边界：越界样本按 0 处理，并按实际参与的权重重新归一化
      let wsum = 0;
      for (let j = 0; j < taps; j++) {
        const k = k0 + j;
        if (k < 0 || k > last) continue;
        acc += input[k] * h[j];
        wsum += h[j];
      }
      acc = wsum ? acc / wsum : 0;
    }
    out[i] = acc;
  }
  return out;
}

/**
 * MUST AVERAGE ALL CHANNELS: AudioBuffer 每通道应等长；取平均保留左右声道且不因声道数而放大。
 * 📐 CONTRACT: 空声道为空、单声道复制，长度不等报错而不是产生 NaN。
 * 🔗 RELATED: student/chat/page.tsx 的附件解码与 MediaRecorder 回退；scripts/test-audio.mjs。
 * ⛔ DO NOT REVERT: 不只读 getChannelData(0)，否则右声道独有的语音会丢失。
 */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length <= 1) return new Float32Array(channels[0] || []);
  const len = channels[0].length;
  const out = new Float32Array(len);
  for (const ch of channels) {
    if (ch.length !== len) throw new RangeError("Audio channels must have equal lengths");
    for (let i = 0; i < len; i++) out[i] += ch[i] / channels.length;
  }
  return out;
}

/**
 * MUST KEEP WAV FIELDS IN SYNC: 固定 44 字节头、单声道、16bit little-endian PCM，头和 data 长度必须一致。
 * 📐 CONTRACT: 采样率为正整数且 byteRate 可放入 uint32；超幅样本饱和到 int16。
 * 🔗 RELATED: pcmToWavDataUrl、scripts/test-audio.mjs、src/app/api/chat/route.ts 的 audio/wav 发送链路。
 * ⛔ DO NOT REVERT: 不能仅更改 MIME 假装 WAV，也不能将其它位深数据套用此头。
 */
export function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  assertSampleRate(sampleRate);
  if (!Number.isInteger(sampleRate) || sampleRate * 2 > 0xffffffff) throw new RangeError("Invalid WAV sample rate");
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/**
 * MUST SHARE THE SAME ENCODER: 录音/文件两入口均输出 16kHz 单声道 PCM WAV 的 data URL。
 * 📐 CONTRACT: 浏览器 FileReader 只封装字节，不另做重采样；🔗 RELATED: 上方 resample/encodeWav 与 student/chat/page.tsx。
 * ⛔ DO NOT REVERT: 不引入第二套离线重采样；Node 自动化直接验证上述纯函数的字节与频响。
 */
export async function pcmToWavDataUrl(pcm: Float32Array, srcRate: number): Promise<string> {
  const wav = encodeWav(resample(pcm, srcRate, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([wav], { type: "audio/wav" }));
  });
}
