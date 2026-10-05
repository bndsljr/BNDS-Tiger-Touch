/**
 * 演出时钟。
 *
 * ## 为什么时钟在服务端而不是浏览器
 *
 * 需求 R4.2 要求「音乐与推 cue 由**同一时钟**驱动」。
 * 因此：
 * - **音频在浏览器播放**（音质、用户手势授权、无需服务端音频驱动）
 * - **时钟与调度在服务端**（单调、可测、可断言、不受浏览器标签页节流影响）
 * - 浏览器周期回报音频 `currentTime` 做**漂移校正**
 *
 * 这使「观众听到的」与「推 cue 的时刻」锚定在同一个时间原点上。
 *
 * ## 漂移校正策略
 *
 * 浏览器的 `audio.currentTime` 会与我们的单调时钟缓慢偏离。
 * 直接跳变会让 cue 时刻抖动，因此：
 * - 偏差 **小于 `hardResyncThresholdMs`** → 以**渐进补偿**方式吸收（不影响 cue 触发节奏）
 * - 偏差 **超过阈值** → 硬重同步（视为 seek，需重新武装已过时刻的卡点）
 */

export interface ShowClockOptions {
  /**
   * 超过此偏差即硬重同步（毫秒）。
   * 默认 150ms —— 对剧场而言超过这个量级说明发生了真实的跳转/卡顿，
   * 而非正常抖动，此时保时钟准确比保平滑更重要。
   */
  hardResyncThresholdMs?: number;
  /**
   * 渐进补偿比例（0–1）。每次校正只吸收偏差的该比例，
   * 避免补偿本身造成可听/可见的突变。
   */
  slewFactor?: number;
}

export interface ClockSyncResult {
  /** 本次校正前的预测位置（ms） */
  predictedMs: number;
  /** 浏览器报告的位置（ms） */
  reportedMs: number;
  /** 偏差 = reported - predicted */
  driftMs: number;
  /** 是否发生了硬重同步 */
  hardResynced: boolean;
}

export class ShowClock {
  private anchorMonoMs = 0;
  private anchorPosMs = 0;
  private running = false;
  private durationMs = 0;

  /** 累积的渐进补偿量（ms），会被逐步消化 */
  private slewRemainingMs = 0;

  private readonly hardResyncThresholdMs: number;
  private readonly slewFactor: number;

  /** 可注入的单调时钟，便于测试 */
  private readonly mono: () => number;

  private lastSync: ClockSyncResult | null = null;

  constructor(options: ShowClockOptions & { mono?: () => number } = {}) {
    this.hardResyncThresholdMs = options.hardResyncThresholdMs ?? 150;
    this.slewFactor = options.slewFactor ?? 0.15;
    this.mono = options.mono ?? (() => performance.now());
  }

  get isRunning(): boolean {
    return this.running;
  }

  get lastSyncResult(): ClockSyncResult | null {
    return this.lastSync;
  }

  setDuration(ms: number): void {
    this.durationMs = Math.max(0, ms);
  }

  get duration(): number {
    return this.durationMs;
  }

  /** 当前演出位置（毫秒）。 */
  now(): number {
    if (!this.running) return this.anchorPosMs;
    const elapsed = this.mono() - this.anchorMonoMs;
    return Math.max(0, this.anchorPosMs + elapsed + this.slewRemainingMs);
  }

  /** 从指定位置开始播放。 */
  start(fromMs = 0): void {
    this.anchorPosMs = Math.max(0, fromMs);
    this.anchorMonoMs = this.mono();
    this.slewRemainingMs = 0;
    this.running = true;
  }

  /** 暂停：把当前位置固化下来。 */
  pause(): void {
    if (!this.running) return;
    this.anchorPosMs = this.now();
    this.slewRemainingMs = 0;
    this.running = false;
  }

  resume(): void {
    if (this.running) return;
    this.anchorMonoMs = this.mono();
    this.running = true;
  }

  /**
   * 跳转到指定位置。
   * **调用方需要重新武装已过时刻的卡点** —— 这是 scheduler 的职责。
   */
  seek(toMs: number): void {
    this.anchorPosMs = Math.max(0, toMs);
    this.anchorMonoMs = this.mono();
    this.slewRemainingMs = 0;
  }

  reset(): void {
    this.pause();
    this.anchorPosMs = 0;
    this.slewRemainingMs = 0;
  }

  /**
   * 用浏览器报告的音频位置校正时钟。
   *
   * 应在音频播放期间以约 1–4 Hz 调用 —— 更频繁没有必要，
   * 且会增加抖动来源。
   */
  syncTo(reportedMs: number): ClockSyncResult {
    const predictedMs = this.now();
    const driftMs = reportedMs - predictedMs;
    const abs = Math.abs(driftMs);

    if (abs > this.hardResyncThresholdMs) {
      // 真实跳转/卡顿：保准确
      this.anchorPosMs = Math.max(0, reportedMs);
      this.anchorMonoMs = this.mono();
      this.slewRemainingMs = 0;
      const result: ClockSyncResult = { predictedMs, reportedMs, driftMs, hardResynced: true };
      this.lastSync = result;
      return result;
    }

    // 正常抖动：把偏差摊到后续若干个采样周期里逐步吸收。
    // 直接把偏差加进 slewRemaining 会让 now() 立刻跳变，因此这里改为
    // "锚点微调 + 保留残差"的方式：吸收一部分，其余留待下次。
    const absorb = driftMs * this.slewFactor;
    this.anchorPosMs += absorb;
    this.slewRemainingMs = 0;

    const result: ClockSyncResult = { predictedMs, reportedMs, driftMs, hardResynced: false };
    this.lastSync = result;
    return result;
  }

  /** 是否已播到结尾。 */
  isFinished(): boolean {
    return this.durationMs > 0 && this.now() >= this.durationMs;
  }
}
