/**
 * 曲目与卡点表。
 *
 * 一个卡点（CueMark）= 一个时刻 + 一组要推的散 cue。
 * 因为本项目用**散的 cue**，一个卡点可以同时推多个 cue（例如"面光 + 侧光"一起上），
 * 也可以只推一个。这比 cue list 的顺序推进更灵活，且不排斥人工随时插手。
 */

export interface CueMark {
  id: string;
  /** 相对音频起点的时刻（毫秒） */
  tMs: number;
  /** 要触发的散 cue id（本项目内的 id，不是 TitanId） */
  cueIds: string[];
  /** 触发电平 0–1 */
  level: number;
  /** 可选：本次触发的额外渐变时间（毫秒）；0 表示用 cue 自身设置 */
  fadeMs?: number;
  note?: string;
}

export interface Song {
  id: string;
  name: string;
  /** 相对本系统 web 根目录的音频路径，或绝对 URL */
  audioPath: string;
  durationMs: number;
  /**
   * 整曲偏移（毫秒）。正值 = 所有卡点延后。
   * 用于"In a hurry 时统一挪几帧"的微调，避免逐个改时间。
   */
  offsetMs: number;
  marks: CueMark[];
}

export function emptySong(name = '新曲目', audioPath = ''): Song {
  return { id: makeId('song'), name, audioPath, durationMs: 0, offsetMs: 0, marks: [] };
}

/** 卡点的**有效时刻** —— 已计入整曲偏移。 */
export function effectiveTimeMs(song: Song, mark: CueMark): number {
  return Math.max(0, mark.tMs + song.offsetMs);
}

/** 按时间排序 —— 调度器要求有序。 */
export function sortedMarks(song: Song): CueMark[] {
  return [...song.marks].sort((a, b) => effectiveTimeMs(song, a) - effectiveTimeMs(song, b));
}

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ── 时间戳解析 ────────────────────────────────────────────────────────────

/**
 * 解析人写的时间戳，支持：
 * - `mm:ss.mmm`（如 `01:23.480`）
 * - `hh:mm:ss.mmm`
 * - `ss.mmm`
 * - 纯毫秒数字
 */
export function parseTimestamp(text: string, frameRate?: number): number | null {
  const t = text.trim();
  if (t === '') return null;

  // 时间码 HH:MM:SS:FF
  if (/^\d+:\d{2}:\d{2}:\d{2}$/.test(t)) {
    const [h, m, s, f] = t.split(':').map(Number) as [number, number, number, number];
    const fps = frameRate ?? 25;
    return Math.round((((h * 60 + m) * 60 + s) + f / fps) * 1000);
  }

  // 纯数字 = 毫秒
  if (/^\d+$/.test(t)) return Number(t);

  const parts = t.split(':');
  if (parts.length === 1) {
    const n = Number(parts[0]);
    return Number.isFinite(n) ? Math.round(n * 1000) : null; // 秒
  }
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return null;

  let seconds = 0;
  for (const n of nums) seconds = seconds * 60 + n;
  return Math.round(seconds * 1000);
}

/** 毫秒 → `mm:ss.mmm` 展示形式。 */
export function formatTimestamp(ms: number): string {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.floor(safe / 1000);
  const millis = Math.floor(safe % 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
