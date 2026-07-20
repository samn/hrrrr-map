/**
 * Main-thread tracker of which forecast frames the worker holds, indexed by
 * layer and lead hour, with lookup of the nearest loaded frames around a
 * fractional time for crossfaded rendering while later passes are still
 * downloading. The frame bytes themselves stay in the worker.
 */

export interface FrameNeighbors {
  /** Lead index of the frame at or before t (or the earliest loaded). */
  a: number;
  /** Lead index of the frame after t; equals `a` when only one side exists. */
  b: number;
  /** Blend fraction 0..1 from a to b. */
  blend: number;
}

export class FrameStore {
  private readonly loaded = new Map<string, boolean[]>();
  readonly leadHours: number[];
  private listeners: (() => void)[] = [];

  constructor(layerIds: string[], leadHours: number[]) {
    this.leadHours = leadHours;
    for (const id of layerIds) {
      this.loaded.set(id, new Array<boolean>(leadHours.length).fill(false));
    }
  }

  markLoaded(layerId: string, leadIndex: number): void {
    const arr = this.loaded.get(layerId);
    if (!arr || leadIndex < 0 || leadIndex >= arr.length) return;
    arr[leadIndex] = true;
    for (const cb of this.listeners) cb();
  }

  onFrame(cb: () => void): void {
    this.listeners.push(cb);
  }

  isLoaded(layerId: string, leadIndex: number): boolean {
    return this.loaded.get(layerId)?.[leadIndex] ?? false;
  }

  loadedCount(layerId: string): number {
    let n = 0;
    for (const f of this.loaded.get(layerId) ?? []) if (f) n++;
    return n;
  }

  /** True when at least two frames of the layer are available. */
  isAnimatable(layerId: string): boolean {
    return this.loadedCount(layerId) >= 2;
  }

  /**
   * Nearest loaded frames bracketing time `t` (hours). Returns null when
   * nothing is loaded for the layer yet.
   */
  neighbors(layerId: string, t: number): FrameNeighbors | null {
    const arr = this.loaded.get(layerId);
    if (!arr) return null;
    const hours = this.leadHours;
    let below = -1;
    let above = -1;
    for (let i = 0; i < arr.length; i++) {
      if (!arr[i]) continue;
      if (hours[i]! <= t) below = i;
      if (hours[i]! >= t && above === -1) above = i;
    }
    if (below === -1 && above === -1) return null;
    if (below === -1) return { a: above, b: above, blend: 0 };
    if (above === -1 || above === below) return { a: below, b: below, blend: 0 };
    const span = hours[above]! - hours[below]!;
    const blend = span > 0 ? (t - hours[below]!) / span : 0;
    return { a: below, b: above, blend: Math.max(0, Math.min(1, blend)) };
  }
}
