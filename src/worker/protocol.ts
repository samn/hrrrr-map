/** Messages between the main thread and the data worker. */

export interface OpenRequest {
  type: "open";
  storeUrl: string;
  layerIds: string[];
  /** Grid downsample factor (1 = full 3 km resolution). */
  downsample: number;
  /** Canvas width in pixels for the reprojection index map. */
  canvasWidth: number;
  /**
   * Transfer quantized frame bytes to the main thread as they load (GPU
   * renderer) instead of keeping them worker-side for paint requests.
   */
  sendFrameBytes: boolean;
}

export interface LoadAllRequest {
  type: "loadAll";
}

/** One overlay to paint: bracketing lead indices and a blend fraction. */
export interface PaintJob {
  layerId: string;
  a: number;
  b: number;
  blend: number;
}

export interface PaintRequest {
  type: "paint";
  jobs: PaintJob[];
  /** Spent RGBA buffers returned for reuse (transferred). */
  recycle: ArrayBuffer[];
}

export type MainToWorker = OpenRequest | LoadAllRequest | PaintRequest;

export interface OpenedMessage {
  type: "opened";
  /** Forecast init time, epoch ms. */
  initTimeMs: number;
  /** Lead offsets, hours. */
  leadHours: number[];
  /** Overlay canvas dimensions (the index map stays in the worker). */
  indexWidth: number;
  indexHeight: number;
  /** Canvas corner lon/lats: TL, TR, BR, BL. */
  corners: [number, number][];
}

/**
 * A frame arrived and is paintable. The bytes stay in the worker unless the
 * open request set `sendFrameBytes`, in which case they are transferred here
 * (quantized values, frame ny x nx) and the worker keeps nothing.
 */
export interface FrameLoadedMessage {
  type: "frameLoaded";
  layerId: string;
  leadIndex: number;
  data?: Uint8Array;
}

export interface PaintedMessage {
  type: "painted";
  /** One entry per painted job; RGBA canvas pixels (transferred). */
  frames: { layerId: string; pixels: Uint8ClampedArray<ArrayBuffer> }[];
}

export interface ProgressMessage {
  type: "progress";
  loaded: number;
  total: number;
  /** True once the first coarse pass has fully arrived. */
  firstPassDone: boolean;
}

export interface FrameErrorMessage {
  type: "frameError";
  layerId: string;
  leadIndex: number;
  message: string;
}

export interface FatalErrorMessage {
  type: "error";
  message: string;
}

export type WorkerToMain =
  | OpenedMessage
  | FrameLoadedMessage
  | PaintedMessage
  | ProgressMessage
  | FrameErrorMessage
  | FatalErrorMessage;
