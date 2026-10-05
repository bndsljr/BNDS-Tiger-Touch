/**
 * 时间码。
 *
 * ## 已核实的线格式
 *
 * `TimecodeTime` 的查询串格式是 **`HH:MM:SS:FF`**（时:分:秒:帧）。
 *
 * 文档把这个参数渲染成 `time={}`，**掩盖了一个完全明确的格式** ——
 * 这是文档缺陷而非真实未知。该结论有两条独立证据：
 *  1. 社区实测可用调用：`SetCueTimecodeWithCueNumber?handle_titanId=1&cueNumber=1&time=11:22:33:44`
 *  2. 文档内交叉印证：`Timecode.GetTimecodeTimePart(time, index)` 说明
 *     *"index: 0 for hours, 1 for minutes, 2 for seconds, 3 for frames"* —— **恰好四段**
 *
 * 回读：`GET /titan/get/2/Timecode/Context/LiveTime`（**字符串**，可轮询）。
 */

/** 支持的帧率。取自 `AcwFrameRate` 枚举（文档明确列出）。 */
export const FRAME_RATES = {
  Fps24: 24,
  Fps25: 25,
  /** 29.97 drop-frame */
  Fps29DF: 29.97,
  Fps30: 30,
  /** Internal Timecode */
  Fps44: 44,
  Fps60: 60,
  /** Winamp / Cue View 显示用 */
  Fps100: 100,
  /** 毫秒 */
  Fps1000: 1000,
} as const;

export type FrameRateName = keyof typeof FRAME_RATES;

export interface TimecodeParts {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
}

/** 把 `HH:MM:SS:FF` 解析为分段。宽容对待 `1:2:3:4` 这类未补零写法。 */
export function parseTimecodeTime(text: string): TimecodeParts {
  const trimmed = text.trim();
  const parts = trimmed.split(':');
  if (parts.length !== 4) {
    throw new TitanTimecodeError(
      `时间码必须是 4 段 HH:MM:SS:FF，收到 ${parts.length} 段：${text}`,
    );
  }
  const nums = parts.map((p) => {
    if (!/^\d+$/.test(p)) throw new TitanTimecodeError(`时间码分段必须是数字：${text}`);
    return Number(p);
  });
  const [hours, minutes, seconds, frames] = nums as [number, number, number, number];
  if (minutes > 59) throw new TitanTimecodeError(`分钟越界（0-59）：${text}`);
  if (seconds > 59) throw new TitanTimecodeError(`秒越界（0-59）：${text}`);
  return { hours, minutes, seconds, frames };
}

/** 格式化为线格式 `HH:MM:SS:FF`。 */
export function formatTimecodeTime(parts: TimecodeParts): string {
  const { hours, minutes, seconds, frames } = parts;
  for (const [label, v, max] of [
    ['hours', hours, Number.POSITIVE_INFINITY],
    ['minutes', minutes, 59],
    ['seconds', seconds, 59],
  ] as const) {
    if (!Number.isInteger(v) || v < 0 || v > max) {
      throw new TitanTimecodeError(`${label} 非法：${v}`);
    }
  }
  if (!Number.isInteger(frames) || frames < 0) {
    throw new TitanTimecodeError(`frames 非法：${frames}`);
  }
  return [hours, minutes, seconds, frames].map((v) => String(v).padStart(2, '0')).join(':');
}

/**
 * 毫秒 → 时间码。
 *
 * 这是一个**有损但有意的**转换：帧是时间码的最小单位，
 * 因此毫秒会被量化到帧边界。29.97 drop-frame 的丢帧计数在此按
 * 名义帧率 30 处理（Titan 的 `Fps29DF` 语义需实测确认）。
 */
export function msToTimecode(ms: number, frameRate: number | FrameRateName): string {
  const fps = typeof frameRate === 'number' ? frameRate : FRAME_RATES[frameRate];
  if (!(fps > 0)) throw new TitanTimecodeError(`帧率非法：${String(frameRate)}`);

  const totalMs = Math.max(0, ms);
  const totalFrames = Math.round((totalMs / 1000) * fps);
  const framesPerSecond = Math.round(fps);
  const fpsInt = framesPerSecond > 0 ? framesPerSecond : 1;

  const totalSeconds = Math.floor(totalFrames / fpsInt);
  const frames = totalFrames % fpsInt;
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  return formatTimecodeTime({ hours, minutes, seconds, frames });
}

/** 时间码 → 毫秒（四舍五入到毫秒）。 */
export function timecodeToMs(text: string, frameRate: number | FrameRateName): number {
  const fps = typeof frameRate === 'number' ? frameRate : FRAME_RATES[frameRate];
  if (!(fps > 0)) throw new TitanTimecodeError(`帧率非法：${String(frameRate)}`);
  const { hours, minutes, seconds, frames } = parseTimecodeTime(text);
  const totalFrames = ((hours * 60 + minutes) * 60 + seconds) * Math.round(fps) + frames;
  return (totalFrames / fps) * 1000;
}

export class TitanTimecodeError extends Error {
  override readonly name = 'TitanTimecodeError';
}
