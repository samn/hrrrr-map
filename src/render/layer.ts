/**
 * A forecast overlay: a canvas added to MapLibre as a canvas source + raster
 * layer. The pixels are painted off-thread by the data worker (see
 * worker/dataWorker.ts); this class only blits finished RGBA frames.
 */
import type { CanvasSource, Map as MapLibreMap } from "maplibre-gl";

/** Canvas geometry from the worker's reprojection map. */
export interface OverlayPlacement {
  width: number;
  height: number;
  /** Corner lon/lats: TL, TR, BR, BL. */
  corners: [number, number][];
}

export class ForecastLayer {
  readonly id: string;
  private readonly map: MapLibreMap;
  private readonly placement: OverlayPlacement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private pauseScheduled = false;

  constructor(map: MapLibreMap, id: string, placement: OverlayPlacement) {
    this.map = map;
    this.id = id;
    this.placement = placement;
    this.canvas = document.createElement("canvas");
    this.canvas.width = placement.width;
    this.canvas.height = placement.height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
  }

  addTo(): void {
    this.map.addSource(this.id, {
      type: "canvas",
      canvas: this.canvas,
      coordinates: this.placement.corners as [
        [number, number],
        [number, number],
        [number, number],
        [number, number],
      ],
      animate: false,
    });
    this.map.addLayer({
      id: this.id,
      type: "raster",
      source: this.id,
      paint: {
        "raster-opacity": 0.85,
        "raster-resampling": "linear",
        "raster-fade-duration": 0,
      },
    });
  }

  /** Blit worker-painted RGBA pixels; the caller may reuse the buffer after. */
  render(pixels: Uint8ClampedArray<ArrayBuffer>): void {
    if (pixels.length !== this.placement.width * this.placement.height * 4) return;
    this.ctx.putImageData(new ImageData(pixels, this.placement.width, this.placement.height), 0, 0);
    this.refresh();
  }

  /** Nudge MapLibre to re-read the (non-animated) canvas texture once. */
  private refresh(): void {
    const source = this.map.getSource(this.id) as CanvasSource | undefined;
    if (!source) return;
    source.play();
    this.map.triggerRepaint();
    if (!this.pauseScheduled) {
      this.pauseScheduled = true;
      requestAnimationFrame(() => {
        this.pauseScheduled = false;
        (this.map.getSource(this.id) as CanvasSource | undefined)?.pause();
      });
    }
  }

  setVisible(visible: boolean): void {
    if (!this.map.getLayer(this.id)) return;
    this.map.setLayoutProperty(this.id, "visibility", visible ? "visible" : "none");
    if (visible) this.refresh();
  }
}
