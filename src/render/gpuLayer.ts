/**
 * GPU forecast overlay: a MapLibre custom layer that reprojects the HRRR
 * grid, crossfades bracketing frames, and applies the palette entirely in a
 * fragment shader. Quantized frames upload once as R8 textures; per-frame
 * work on the CPU is just uniform updates and a draw call.
 *
 * The fragment shader inverts each screen pixel's mercator position through
 * the Lambert conformal projection to a fractional grid cell, so the overlay
 * resolves at screen resolution (the canvas renderer resamples a fixed
 * 1600px-wide raster instead).
 */
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import { makeLccConstants, makeLccProjection, type LccGrid } from "../lib/lcc.ts";
import { gridMercatorBounds } from "../lib/reproject.ts";

/** Matches the canvas renderer's raster-opacity. */
const OPACITY = 0.85;

/**
 * Frame textures kept resident per layer. Playback only ever needs the two
 * bracketing frames; a few extra cover scrubbing without re-uploads.
 */
const TEXTURE_CACHE_SIZE = 8;

/** Mesh subdivision so the quad follows the horizon under globe projection. */
const MESH_COLS = 32;
const MESH_ROWS = 16;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_frame_a;
uniform sampler2D u_frame_b;
uniform sampler2D u_lut;
uniform float u_blend;
uniform float u_opacity;
// Lambert conformal conic constants (see lib/lcc.ts).
uniform float u_n;
uniform float u_rf;
uniform float u_rho0;
uniform float u_lam0;
// LCC coords of the grid's first point, metres.
uniform vec2 u_origin;
// Grid spacing, metres.
uniform vec2 u_cell;
// Full-resolution grid dimensions (nx, ny).
uniform vec2 u_grid;
// Half-texel offset of the (possibly downsampled) frame textures.
uniform vec2 u_half_texel;

in vec2 v_merc;
out vec4 fragColor;

const float PI2 = 6.283185307179586;

void main() {
  // Normalized mercator -> lon/lat (radians).
  float lonRad = v_merc.x * PI2 - PI2 * 0.5;
  float latRad = atan(sinh((0.5 - v_merc.y) * PI2));

  // LCC forward projection -> fractional grid cell (north-up rows).
  float dlam = mod(lonRad - u_lam0 + PI2 * 0.5, PI2) - PI2 * 0.5;
  float rho = u_rf / pow(tan(PI2 * 0.125 + latRad * 0.5), u_n);
  float theta = u_n * dlam;
  float x = rho * sin(theta);
  float y = u_rho0 - rho * cos(theta);
  float col = (x - u_origin.x) / u_cell.x;
  float row = (u_grid.y - 1.0) - (y - u_origin.y) / u_cell.y;
  if (col < -0.5 || col > u_grid.x - 0.5 || row < -0.5 || row > u_grid.y - 0.5) {
    discard;
  }

  // Sample at cell centers; frame textures may be downsampled relative to
  // the grid, which the half-texel offset absorbs.
  vec2 uv = vec2(col, row) / u_grid + u_half_texel;
  float v = mix(texture(u_frame_a, uv).r, texture(u_frame_b, uv).r, u_blend);
  vec4 color = texture(u_lut, vec2((v * 255.0 + 0.5) / 256.0, 0.5));
  fragColor = vec4(color.rgb * color.a, color.a) * u_opacity;
}
`;

/**
 * True when the GPU renderer can run here: WebGL2 plus a successful compile
 * and link of the overlay shader (guards against quirky drivers). The canvas
 * renderer is the fallback when this fails.
 */
export function gpuRendererSupported(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return false;
    const compile = (type: number, source: string): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };
    const vs = compile(
      gl.VERTEX_SHADER,
      `#version 300 es
in vec2 a_pos;
out vec2 v_merc;
void main() { v_merc = a_pos; gl_Position = vec4(a_pos, 0.0, 1.0); }
`,
    );
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    let ok = false;
    if (vs && fs) {
      const program = gl.createProgram();
      if (program) {
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        ok = gl.getProgramParameter(program, gl.LINK_STATUS) as boolean;
        gl.deleteProgram(program);
      }
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

interface CachedTexture {
  texture: WebGLTexture;
  lastUse: number;
}

export class GpuForecastLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private readonly grid: LccGrid;
  private readonly frameNx: number;
  private readonly frameNy: number;
  private readonly lut: Uint8ClampedArray;

  private map: MapLibreMap | null = null;
  private visible = true;
  private a = -1;
  private b = -1;
  private blend = 0;

  private readonly frames = new Map<number, Uint8Array>();
  private readonly textures = new Map<number, CachedTexture>();
  private tick = 0;

  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private programVariant = "";
  private locations = new Map<string, WebGLUniformLocation | null>();
  private vao: WebGLVertexArrayObject | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private indexCount = 0;
  private lutTexture: WebGLTexture | null = null;

  constructor(id: string, grid: LccGrid, downsample: number, lut: Uint8ClampedArray) {
    this.id = id;
    this.grid = grid;
    this.frameNx = Math.ceil(grid.nx / downsample);
    this.frameNy = Math.ceil(grid.ny / downsample);
    this.lut = lut;
  }

  /** Store a loaded frame's quantized bytes; textures upload on demand. */
  setFrame(leadIndex: number, data: Uint8Array): void {
    this.frames.set(leadIndex, data);
    const cached = this.textures.get(leadIndex);
    if (cached) {
      this.gl?.deleteTexture(cached.texture);
      this.textures.delete(leadIndex);
    }
    if (leadIndex === this.a || leadIndex === this.b) this.map?.triggerRepaint();
  }

  /** Set the displayed frame pair + blend; returns whether anything changed. */
  setTime(a: number, b: number, blend: number): boolean {
    if (a === this.a && b === this.b && blend === this.blend) return false;
    this.a = a;
    this.b = b;
    this.blend = blend;
    return true;
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error("GPU forecast layer requires WebGL2");
    }
    this.map = map;
    this.gl = gl;
    this.createMesh(gl);
    this.lutTexture = this.createLutTexture(gl);
  }

  onRemove(): void {
    const gl = this.gl;
    if (!gl) return;
    for (const { texture } of this.textures.values()) gl.deleteTexture(texture);
    this.textures.clear();
    if (this.lutTexture) gl.deleteTexture(this.lutTexture);
    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
    this.gl = null;
    this.map = null;
    this.program = null;
    this.programVariant = "";
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.visible || !(gl instanceof WebGL2RenderingContext)) return;
    const textureA = this.ensureTexture(gl, this.a);
    if (!textureA) return;
    const textureB = this.b !== this.a ? this.ensureTexture(gl, this.b) : textureA;

    this.ensureProgram(gl, options.shaderData);
    const program = this.program;
    if (!program || !this.vao || !this.lutTexture) return;

    gl.useProgram(program);
    gl.bindVertexArray(this.vao);

    // Projection uniforms from MapLibre (globe variants use the extras;
    // missing locations are silently ignored per the WebGL spec).
    const p = options.defaultProjectionData;
    gl.uniformMatrix4fv(this.loc("u_projection_matrix"), false, p.mainMatrix);
    gl.uniform4f(this.loc("u_projection_tile_mercator_coords"), ...p.tileMercatorCoords);
    gl.uniform4f(this.loc("u_projection_clipping_plane"), ...p.clippingPlane);
    gl.uniform1f(this.loc("u_projection_transition"), p.projectionTransition);
    gl.uniformMatrix4fv(this.loc("u_projection_fallback_matrix"), false, p.fallbackMatrix);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textureA);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, textureB ?? textureA);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.uniform1f(this.loc("u_blend"), textureB && textureB !== textureA ? this.blend : 0);

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }

  private loc(name: string): WebGLUniformLocation | null {
    return this.locations.get(name) ?? null;
  }

  /** Compile (or recompile on projection change) the layer's program. */
  private ensureProgram(gl: WebGL2RenderingContext, shaderData: CustomRenderMethodInput["shaderData"]): void {
    if (this.program && this.programVariant === shaderData.variantName) return;
    if (this.program) gl.deleteProgram(this.program);

    const vertexSource = `#version 300 es
${shaderData.vertexShaderPrelude}
${shaderData.define}
in vec2 a_pos;
out vec2 v_merc;
void main() {
  v_merc = a_pos;
  gl_Position = projectTile(a_pos);
}
`;
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("createShader failed");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`forecast shader: ${log}`);
      }
      return shader;
    };
    const vs = compile(gl.VERTEX_SHADER, vertexSource);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    const program = gl.createProgram();
    if (!program) throw new Error("createProgram failed");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "a_pos");
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`forecast shader link: ${log}`);
    }
    this.program = program;
    this.programVariant = shaderData.variantName;

    this.locations = new Map();
    const uniforms = [
      "u_projection_matrix",
      "u_projection_tile_mercator_coords",
      "u_projection_clipping_plane",
      "u_projection_transition",
      "u_projection_fallback_matrix",
      "u_frame_a",
      "u_frame_b",
      "u_lut",
      "u_blend",
      "u_opacity",
      "u_n",
      "u_rf",
      "u_rho0",
      "u_lam0",
      "u_origin",
      "u_cell",
      "u_grid",
      "u_half_texel",
    ];
    for (const name of uniforms) this.locations.set(name, gl.getUniformLocation(program, name));

    gl.useProgram(program);
    gl.uniform1i(this.loc("u_frame_a"), 0);
    gl.uniform1i(this.loc("u_frame_b"), 1);
    gl.uniform1i(this.loc("u_lut"), 2);
    gl.uniform1f(this.loc("u_opacity"), OPACITY);

    const { n, rf, rho0, lam0 } = makeLccConstants(this.grid);
    const [x1, y1] = makeLccProjection(this.grid).forward(this.grid.lo1, this.grid.la1);
    gl.uniform1f(this.loc("u_n"), n);
    gl.uniform1f(this.loc("u_rf"), rf);
    gl.uniform1f(this.loc("u_rho0"), rho0);
    gl.uniform1f(this.loc("u_lam0"), lam0);
    gl.uniform2f(this.loc("u_origin"), x1, y1);
    gl.uniform2f(this.loc("u_cell"), this.grid.dx, this.grid.dy);
    gl.uniform2f(this.loc("u_grid"), this.grid.nx, this.grid.ny);
    gl.uniform2f(this.loc("u_half_texel"), 0.5 / this.frameNx, 0.5 / this.frameNy);
  }

  /** Subdivided quad over the grid's mercator bounding box. */
  private createMesh(gl: WebGL2RenderingContext): void {
    const { xMin, xMax, yMin, yMax } = gridMercatorBounds(this.grid);
    const positions = new Float32Array((MESH_COLS + 1) * (MESH_ROWS + 1) * 2);
    let v = 0;
    for (let r = 0; r <= MESH_ROWS; r++) {
      const y = yMin + (r / MESH_ROWS) * (yMax - yMin);
      for (let c = 0; c <= MESH_COLS; c++) {
        positions[v++] = xMin + (c / MESH_COLS) * (xMax - xMin);
        positions[v++] = y;
      }
    }
    const indices = new Uint16Array(MESH_COLS * MESH_ROWS * 6);
    let i = 0;
    for (let r = 0; r < MESH_ROWS; r++) {
      for (let c = 0; c < MESH_COLS; c++) {
        const tl = r * (MESH_COLS + 1) + c;
        const bl = tl + MESH_COLS + 1;
        indices[i++] = tl;
        indices[i++] = bl;
        indices[i++] = tl + 1;
        indices[i++] = tl + 1;
        indices[i++] = bl;
        indices[i++] = bl + 1;
      }
    }
    this.indexCount = indices.length;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  private createLutTexture(gl: WebGL2RenderingContext): WebGLTexture {
    const texture = gl.createTexture();
    if (!texture) throw new Error("createTexture failed");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      256,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(this.lut.buffer, this.lut.byteOffset, this.lut.byteLength),
    );
    return texture;
  }

  /** Upload (or reuse) the R8 texture for a lead index; LRU-evicts extras. */
  private ensureTexture(gl: WebGL2RenderingContext, leadIndex: number): WebGLTexture | null {
    this.tick++;
    const cached = this.textures.get(leadIndex);
    if (cached) {
      cached.lastUse = this.tick;
      return cached.texture;
    }
    const data = this.frames.get(leadIndex);
    if (!data) return null;

    const texture = gl.createTexture();
    if (!texture) return null;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.frameNx, this.frameNy, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.textures.set(leadIndex, { texture, lastUse: this.tick });

    if (this.textures.size > TEXTURE_CACHE_SIZE) {
      let oldest = -1;
      let oldestUse = Infinity;
      for (const [idx, entry] of this.textures) {
        if (idx === this.a || idx === this.b) continue;
        if (entry.lastUse < oldestUse) {
          oldestUse = entry.lastUse;
          oldest = idx;
        }
      }
      const evict = this.textures.get(oldest);
      if (evict) {
        gl.deleteTexture(evict.texture);
        this.textures.delete(oldest);
      }
    }
    return texture;
  }
}
