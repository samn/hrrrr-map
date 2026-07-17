/**
 * Playback model for the forecast animation: a fractional time in hours
 * [0, maxHours], driven by requestAnimationFrame when playing, scrubbable
 * at any moment.
 */

export interface TimelineOptions {
  maxHours: number;
  /** Playback speed in forecast-hours per wall-clock second. */
  speed?: number;
  /** rAF injection point for tests. */
  raf?: (cb: (ts: number) => void) => number;
  caf?: (id: number) => void;
}

export class Timeline {
  t = 0;
  playing = false;
  readonly maxHours: number;
  speed: number;

  private readonly raf: (cb: (ts: number) => void) => number;
  private readonly caf: (id: number) => void;
  private rafId: number | null = null;
  private lastTs: number | null = null;
  private listeners: (() => void)[] = [];

  constructor(opts: TimelineOptions) {
    this.maxHours = opts.maxHours;
    this.speed = opts.speed ?? 6;
    this.raf = opts.raf ?? ((cb) => requestAnimationFrame(cb));
    this.caf = opts.caf ?? ((id) => cancelAnimationFrame(id));
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.lastTs = null;
    this.tick();
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.rafId !== null) this.caf(this.rafId);
    this.rafId = null;
    this.lastTs = null;
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Jump to a time; pauses playback (manual scrub wins). */
  scrubTo(t: number): void {
    if (this.playing) this.pause();
    this.t = Math.max(0, Math.min(this.maxHours, t));
    this.emit();
  }

  private tick = (): void => {
    if (!this.playing) return;
    this.rafId = this.raf((ts) => {
      if (!this.playing) return;
      if (this.lastTs !== null) {
        const dt = Math.min(0.25, (ts - this.lastTs) / 1000);
        this.t += dt * this.speed;
        if (this.t > this.maxHours) this.t = 0; // loop
        this.emit();
      }
      this.lastTs = ts;
      this.tick();
    });
  };
}
