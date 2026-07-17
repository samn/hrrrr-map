/**
 * A forecast overlay: an offscreen-painted canvas added to MapLibre as a
 * canvas source + raster layer. Repaints are a gather through the
 * reprojection index map and a palette LUT (see lib/reproject.ts).
 */
import type { CanvasSource, Map as MapLibreMap } from "maplibre-gl";
import { paintFrame, type IndexMap } from "../lib/reproject.ts";

export class ForecastLayer {
  readonly id: string;
  private readonly map: MapLibreMap;
  private readonly lut: Uint8ClampedArray;
  private readonly indexMap: IndexMap;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly imageData: ImageData;
  private pauseScheduled = false;

  constructor(map: MapLibreMap, id: string, lut: Uint8ClampedArray, indexMap: IndexMap) {
    this.map = map;
    this.id = id;
    this.lut = lut;
    this.indexMap = indexMap;
    this.canvas = document.createElement("canvas");
    this.canvas.width = indexMap.width;
    this.canvas.height = indexMap.height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
    this.imageData = ctx.createImageData(indexMap.width, indexMap.height);
  }

  addTo(): void {
    this.map.addSource(this.id, {
      type: "canvas",
      canvas: this.canvas,
      coordinates: this.indexMap.corners as [
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

  render(frameA: Uint8Array, frameB: Uint8Array | null, blend: number): void {
    paintFrame(this.indexMap, this.lut, this.imageData.data, frameA, frameB, blend);
    this.ctx.putImageData(this.imageData, 0, 0);
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
