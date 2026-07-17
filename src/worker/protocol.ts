/** Messages between the main thread and the data worker. */

export interface OpenRequest {
  type: "open";
  storeUrl: string;
  layerIds: string[];
  /** Grid downsample factor (1 = full 3 km resolution). */
  downsample: number;
  /** Canvas width in pixels for the reprojection index map. */
  canvasWidth: number;
}

export interface LoadAllRequest {
  type: "loadAll";
}

export type MainToWorker = OpenRequest | LoadAllRequest;

export interface OpenedMessage {
  type: "opened";
  /** Forecast init time, epoch ms. */
  initTimeMs: number;
  /** Lead offsets, hours. */
  leadHours: number[];
  /** Downsampled frame dimensions. */
  gridNy: number;
  gridNx: number;
  /** Reprojection index map (transferred). */
  indexWidth: number;
  indexHeight: number;
  indices: Int32Array;
  /** Canvas corner lon/lats: TL, TR, BR, BL. */
  corners: [number, number][];
}

export interface FrameMessage {
  type: "frame";
  layerId: string;
  leadIndex: number;
  /** Quantized bytes (transferred), gridNy x gridNx. */
  data: Uint8Array;
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
  | FrameMessage
  | ProgressMessage
  | FrameErrorMessage
  | FatalErrorMessage;
