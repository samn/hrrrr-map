/**
 * DOM controls: layer toggle chips with legends, timeline scrubber with
 * play/pause, progress and status. No framework — small, explicit DOM.
 */
import type { LayerConfig } from "../config.ts";
import type { Colormap } from "../lib/colormap.ts";

export interface UICallbacks {
  onScrub(t: number): void;
  onPlayToggle(): void;
  onLayerToggle(id: string, enabled: boolean): void;
  onLocate(): void;
}

const PLAY_ICON = "&#9654;";
const PAUSE_ICON = "&#10074;&#10074;";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
}

export function colormapGradient(cm: Colormap): string {
  const stops = cm.stops.map((s, i) => {
    const pct = (i / (cm.stops.length - 1)) * 100;
    const [r, g, b, a] = s.color;
    return `rgba(${r},${g},${b},${(a / 255).toFixed(2)}) ${pct.toFixed(0)}%`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

export class AppUI {
  private readonly cb: UICallbacks;
  private readonly timeLabel: HTMLElement;
  private readonly relLabel: HTMLElement;
  private readonly initLabel: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly slider: HTMLInputElement;
  private readonly nowTick: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly progressWrap: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly chips = new Map<string, HTMLButtonElement>();
  private maxHours = 48;

  constructor(
    root: HTMLElement,
    layers: { config: LayerConfig; colormap: Colormap; rangeText: string }[],
    cb: UICallbacks,
  ) {
    this.cb = cb;

    const top = el("div", "top-bar", root);
    const titleBox = el("div", "title-box", top);
    el("h1", "app-title", titleBox).textContent = "Smoke & Rain";
    this.initLabel = el("div", "init-label", titleBox);
    this.initLabel.textContent = "Loading forecast…";

    const chipRow = el("div", "chip-row", top);
    for (const { config, colormap, rangeText } of layers) {
      const chip = el("button", "chip chip-on", chipRow);
      chip.type = "button";
      chip.dataset.layer = config.id;
      chip.setAttribute("aria-pressed", "true");
      const label = el("span", "chip-label", chip);
      label.textContent = config.label;
      const bar = el("span", "chip-gradient", chip);
      bar.style.background = colormapGradient(colormap);
      el("span", "chip-range", chip).textContent = rangeText;
      chip.addEventListener("click", () => {
        const on = chip.classList.toggle("chip-on");
        chip.setAttribute("aria-pressed", String(on));
        this.cb.onLayerToggle(config.id, on);
      });
      this.chips.set(config.id, chip);
    }

    const locate = el("button", "locate-btn", root);
    locate.type = "button";
    locate.title = "Center on my location";
    locate.setAttribute("aria-label", "Center on my location");
    locate.innerHTML = "&#9678;";
    locate.addEventListener("click", () => this.cb.onLocate());

    const bottom = el("div", "bottom-bar", root);
    const timeRow = el("div", "time-row", bottom);
    this.playBtn = el("button", "play-btn", timeRow);
    this.playBtn.type = "button";
    this.playBtn.setAttribute("aria-label", "Play animation");
    this.playBtn.innerHTML = PLAY_ICON;
    this.playBtn.addEventListener("click", () => this.cb.onPlayToggle());
    const labels = el("div", "time-labels", timeRow);
    this.timeLabel = el("div", "time-label", labels);
    this.timeLabel.textContent = "—";
    this.relLabel = el("div", "rel-label", labels);

    const sliderWrap = el("div", "slider-wrap", bottom);
    this.slider = el("input", "scrubber", sliderWrap);
    this.slider.type = "range";
    this.slider.min = "0";
    this.slider.max = "48";
    this.slider.step = "0.1";
    this.slider.value = "0";
    this.slider.setAttribute("aria-label", "Forecast hour");
    this.slider.addEventListener("input", () => this.cb.onScrub(Number(this.slider.value)));
    this.nowTick = el("div", "now-tick", sliderWrap);
    this.nowTick.style.display = "none";

    const axis = el("div", "axis-row", bottom);
    for (const h of [0, 12, 24, 36, 48]) {
      const tick = el("span", "axis-tick", axis);
      tick.textContent = h === 0 ? "0h" : `+${h}h`;
    }

    this.progressWrap = el("div", "progress-wrap", bottom);
    this.progressBar = el("div", "progress-bar", this.progressWrap);

    this.statusEl = el("div", "status", root);
    this.setStatus("Loading forecast…", false);
  }

  setMaxHours(h: number): void {
    this.maxHours = h;
    this.slider.max = String(h);
  }

  setInit(initDate: Date): void {
    const fmt = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      hour: "numeric",
      month: "short",
      day: "numeric",
    });
    this.initLabel.textContent = `HRRR forecast from ${fmt.format(initDate)}`;
    // Position the "now" tick on the timeline if it falls inside the window.
    const nowHours = (Date.now() - initDate.getTime()) / 3_600_000;
    if (nowHours >= 0 && nowHours <= this.maxHours) {
      this.nowTick.style.display = "block";
      this.nowTick.style.left = `${(nowHours / this.maxHours) * 100}%`;
    }
  }

  setTime(validDate: Date, t: number, playing: boolean): void {
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric" });
    this.timeLabel.textContent = fmt.format(validDate);
    this.relLabel.textContent = `+${Math.round(t)}h`;
    if (document.activeElement !== this.slider || playing) {
      this.slider.value = String(t);
    }
    this.playBtn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    this.playBtn.setAttribute("aria-label", playing ? "Pause animation" : "Play animation");
  }

  setProgress(loaded: number, total: number): void {
    const done = total > 0 && loaded >= total;
    this.progressWrap.style.opacity = done ? "0" : "1";
    this.progressBar.style.width = total > 0 ? `${(loaded / total) * 100}%` : "0%";
  }

  setStatus(message: string | null, isError: boolean): void {
    if (message === null) {
      this.statusEl.classList.remove("status-visible", "status-error");
      return;
    }
    this.statusEl.textContent = message;
    this.statusEl.classList.add("status-visible");
    this.statusEl.classList.toggle("status-error", isError);
  }
}
