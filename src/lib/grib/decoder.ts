/**
 * Minimal pure-TypeScript GRIB2 decoder covering what the dynamical.org HRRR
 * store actually serves: data representation templates 5.0 (simple packing),
 * 5.2 (complex packing) and 5.3 (complex packing with spatial differencing),
 * with optional bitmap. Grid metadata is parsed for Lambert conformal
 * (template 3.30) grids.
 *
 * Unit tests cross-validate the output against the native gribberish library.
 */

export class GribDecodeError extends Error {
  override name = "GribDecodeError";
}

export interface GribGrid {
  templateNumber: number;
  nx: number;
  ny: number;
  /** Latitude of first grid point, degrees. */
  la1: number;
  /** Longitude of first grid point, degrees (0..360 as encoded). */
  lo1: number;
  /** Orientation longitude LoV, degrees. */
  lov: number;
  /** Latitude where dx/dy are specified (LaD), degrees. */
  lad: number;
  latin1: number;
  latin2: number;
  /** Grid spacing in metres. */
  dx: number;
  dy: number;
  scanMode: number;
  earthRadiusM: number;
}

export interface DecodedGrib {
  /** Values in grid scan order; NaN where the bitmap marks missing points. */
  values: Float32Array;
  grid: GribGrid | null;
  numGridPoints: number;
  discipline: number;
  parameterCategory: number;
  parameterNumber: number;
  referenceTime: Date;
  drsTemplate: number;
}

interface Sections {
  discipline: number;
  s1: Uint8Array;
  s3: Uint8Array | null;
  s4: Uint8Array | null;
  s5: Uint8Array;
  s6: Uint8Array | null;
  s7: Uint8Array;
}

function u16(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

/** GRIB2 signed integers use sign-and-magnitude encoding (high bit = sign). */
function sm16(b: Uint8Array, o: number): number {
  const v = u16(b, o);
  return v & 0x8000 ? -(v & 0x7fff) : v;
}

function sm32(b: Uint8Array, o: number): number {
  const v = u32(b, o);
  return v & 0x80000000 ? -(v & 0x7fffffff) : v;
}

/** Sign-and-magnitude integer spanning `n` bytes (used by DRS 5.3 descriptors). */
function smN(b: Uint8Array, o: number, n: number): number {
  if (n === 0) return 0;
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[o + i]!;
  const signBit = 2 ** (8 * n - 1);
  return v >= signBit ? -(v - signBit) : v;
}

function f32(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0);
}

function splitSections(bytes: Uint8Array): Sections {
  if (bytes.length < 16 || bytes[0] !== 0x47 || bytes[1] !== 0x52 || bytes[2] !== 0x49 || bytes[3] !== 0x42) {
    throw new GribDecodeError("Not a GRIB2 message (missing GRIB magic)");
  }
  const edition = bytes[7]!;
  if (edition !== 2) throw new GribDecodeError(`Unsupported GRIB edition ${edition}`);
  const discipline = bytes[6]!;

  let pos = 16;
  const secs: Partial<Record<number, Uint8Array>> = {};
  while (pos < bytes.length) {
    if (bytes[pos] === 0x37 && bytes[pos + 1] === 0x37 && bytes[pos + 2] === 0x37 && bytes[pos + 3] === 0x37) {
      break; // section 8 "7777"
    }
    if (pos + 5 > bytes.length) throw new GribDecodeError("Truncated GRIB message");
    const len = u32(bytes, pos);
    const num = bytes[pos + 4]!;
    if (len < 5 || pos + len > bytes.length) throw new GribDecodeError(`Bad section ${num} length ${len}`);
    secs[num] = bytes.subarray(pos, pos + len);
    pos += len;
  }
  const s1 = secs[1];
  const s5 = secs[5];
  const s7 = secs[7];
  if (!s1 || !s5 || !s7) throw new GribDecodeError("GRIB message missing required sections");
  return {
    discipline,
    s1,
    s3: secs[3] ?? null,
    s4: secs[4] ?? null,
    s5,
    s6: secs[6] ?? null,
    s7,
  };
}

const EARTH_SHAPE_RADIUS: Record<number, number> = {
  0: 6367470,
  6: 6371229,
  8: 6371200,
};

function parseGrid(s3: Uint8Array): { grid: GribGrid | null; numGridPoints: number } {
  const numGridPoints = u32(s3, 6);
  const template = u16(s3, 12);
  if (template !== 30) return { grid: null, numGridPoints };
  // Template 3.30 (Lambert conformal); offsets are 0-based into the section.
  const shape = s3[14]!;
  let earthRadiusM = EARTH_SHAPE_RADIUS[shape];
  if (shape === 1) {
    const scale = s3[15]!;
    earthRadiusM = u32(s3, 16) / 10 ** scale;
  }
  if (earthRadiusM === undefined) {
    throw new GribDecodeError(`Unsupported earth shape code ${shape}`);
  }
  return {
    numGridPoints,
    grid: {
      templateNumber: template,
      nx: u32(s3, 30),
      ny: u32(s3, 34),
      la1: sm32(s3, 38) * 1e-6,
      lo1: sm32(s3, 42) * 1e-6,
      lad: sm32(s3, 47) * 1e-6,
      lov: sm32(s3, 51) * 1e-6,
      dx: u32(s3, 55) * 1e-3,
      dy: u32(s3, 59) * 1e-3,
      scanMode: s3[64]!,
      latin1: sm32(s3, 65) * 1e-6,
      latin2: sm32(s3, 69) * 1e-6,
      earthRadiusM,
    },
  };
}

/** MSB-first bit reader. */
class BitReader {
  private byte = 0;
  private bit = 0;
  private readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  read(nbits: number): number {
    let result = 0;
    let remaining = nbits;
    while (remaining > 0) {
      const avail = 8 - this.bit;
      const take = remaining < avail ? remaining : avail;
      const shift = avail - take;
      const mask = (1 << take) - 1;
      result = result * (1 << take) + ((this.buf[this.byte]! >> shift) & mask);
      this.bit += take;
      remaining -= take;
      if (this.bit === 8) {
        this.bit = 0;
        this.byte++;
      }
    }
    return result;
  }

  alignToByte(): void {
    if (this.bit !== 0) {
      this.bit = 0;
      this.byte++;
    }
  }
}

interface ComplexParams {
  reference: number;
  binaryScale: number;
  decimalScale: number;
  nbits: number;
  missingManagement: number;
  numGroups: number;
  groupWidthRef: number;
  groupWidthBits: number;
  groupLengthRef: number;
  groupLengthIncrement: number;
  lastGroupLength: number;
  groupLengthBits: number;
  spatialOrder: number;
  extraOctets: number;
}

function parseComplexParams(s5: Uint8Array, template: number): ComplexParams {
  return {
    reference: f32(s5, 11),
    binaryScale: sm16(s5, 15),
    decimalScale: sm16(s5, 17),
    nbits: s5[19]!,
    missingManagement: s5[22]!,
    numGroups: u32(s5, 31),
    groupWidthRef: s5[35]!,
    groupWidthBits: s5[36]!,
    groupLengthRef: u32(s5, 37),
    groupLengthIncrement: s5[41]!,
    lastGroupLength: u32(s5, 42),
    groupLengthBits: s5[46]!,
    spatialOrder: template === 3 ? s5[47]! : 0,
    extraOctets: template === 3 ? s5[48]! : 0,
  };
}

/**
 * Unpack complex-packed integers (templates 7.2 / 7.3) following NCEP
 * g2c comunpack: four bit-streams (references, widths, lengths, values),
 * each byte-aligned, then optional spatial-difference reconstruction.
 */
function unpackComplex(p: ComplexParams, data: Uint8Array, npoints: number): Float64Array {
  if (p.missingManagement !== 0) {
    throw new GribDecodeError(`Missing-value management ${p.missingManagement} not supported`);
  }
  const reader = new BitReader(data);

  // DRS 5.3 prepends the spatial-differencing descriptors: `order` initial
  // values followed by the overall minimum of the differences, each stored
  // in `extraOctets` bytes.
  let ival1 = 0;
  let ival2 = 0;
  let minsd = 0;
  if (p.spatialOrder > 0) {
    if (p.spatialOrder !== 1 && p.spatialOrder !== 2) {
      throw new GribDecodeError(`Unsupported spatial differencing order ${p.spatialOrder}`);
    }
    const n = p.extraOctets;
    let off = 0;
    ival1 = smN(data, off, n);
    off += n;
    if (p.spatialOrder === 2) {
      ival2 = smN(data, off, n);
      off += n;
    }
    minsd = smN(data, off, n);
    off += n;
    for (let i = 0; i < off * 8; i += 8) reader.read(8);
  }

  const ng = p.numGroups;
  const refs = new Int32Array(ng);
  if (p.nbits > 0) {
    for (let i = 0; i < ng; i++) refs[i] = reader.read(p.nbits);
  }
  reader.alignToByte();

  const widths = new Int32Array(ng);
  if (p.groupWidthBits > 0) {
    for (let i = 0; i < ng; i++) widths[i] = p.groupWidthRef + reader.read(p.groupWidthBits);
  } else {
    widths.fill(p.groupWidthRef);
  }
  reader.alignToByte();

  const lengths = new Int32Array(ng);
  if (p.groupLengthBits > 0) {
    for (let i = 0; i < ng; i++) {
      lengths[i] = p.groupLengthRef + p.groupLengthIncrement * reader.read(p.groupLengthBits);
    }
  } else {
    lengths.fill(p.groupLengthRef);
  }
  if (ng > 0) lengths[ng - 1] = p.lastGroupLength;
  reader.alignToByte();

  const ifld = new Float64Array(npoints);
  let k = 0;
  for (let g = 0; g < ng; g++) {
    const width = widths[g]!;
    const len = lengths[g]!;
    const ref = refs[g]!;
    if (k + len > npoints) throw new GribDecodeError("Group lengths exceed data point count");
    if (width === 0) {
      ifld.fill(ref, k, k + len);
      k += len;
    } else {
      for (let j = 0; j < len; j++) ifld[k++] = ref + reader.read(width);
    }
  }
  if (k !== npoints) {
    throw new GribDecodeError(`Unpacked ${k} values, expected ${npoints}`);
  }

  if (p.spatialOrder === 1) {
    ifld[0] = ival1;
    for (let j = 1; j < npoints; j++) ifld[j] = ifld[j]! + minsd + ifld[j - 1]!;
  } else if (p.spatialOrder === 2) {
    ifld[0] = ival1;
    if (npoints > 1) ifld[1] = ival2;
    for (let j = 2; j < npoints; j++) {
      ifld[j] = ifld[j]! + minsd + 2 * ifld[j - 1]! - ifld[j - 2]!;
    }
  }
  return ifld;
}

function unpackSimple(s5: Uint8Array, data: Uint8Array, npoints: number): Float64Array {
  const nbits = s5[19]!;
  const out = new Float64Array(npoints);
  if (nbits === 0) return out;
  const reader = new BitReader(data);
  for (let i = 0; i < npoints; i++) out[i] = reader.read(nbits);
  return out;
}

function parseReferenceTime(s1: Uint8Array): Date {
  const year = u16(s1, 12);
  return new Date(Date.UTC(year, s1[14]! - 1, s1[15]!, s1[16]!, s1[17]!, s1[18]!));
}

/** Decode the first GRIB2 message in `bytes`. */
export function decodeGrib2Message(bytes: Uint8Array): DecodedGrib {
  const secs = splitSections(bytes);
  const { grid, numGridPoints } = secs.s3 ? parseGrid(secs.s3) : { grid: null, numGridPoints: 0 };

  const drsTemplate = u16(secs.s5, 9);
  const npackedPoints = u32(secs.s5, 5);
  const dataBytes = secs.s7.subarray(5);

  let ifld: Float64Array;
  let reference: number;
  let binaryScale: number;
  let decimalScale: number;
  switch (drsTemplate) {
    case 0: {
      reference = f32(secs.s5, 11);
      binaryScale = sm16(secs.s5, 15);
      decimalScale = sm16(secs.s5, 17);
      ifld = unpackSimple(secs.s5, dataBytes, npackedPoints);
      break;
    }
    case 2:
    case 3: {
      const params = parseComplexParams(secs.s5, drsTemplate);
      reference = params.reference;
      binaryScale = params.binaryScale;
      decimalScale = params.decimalScale;
      ifld = unpackComplex(params, dataBytes, npackedPoints);
      break;
    }
    default:
      throw new GribDecodeError(
        `Unsupported data representation template 5.${drsTemplate} (only 5.0, 5.2, 5.3 supported)`,
      );
  }

  const bscale = 2 ** binaryScale;
  const dscale = 10 ** decimalScale;

  const totalPoints = numGridPoints || npackedPoints;
  const values = new Float32Array(totalPoints);

  const bitmapIndicator = secs.s6 ? secs.s6[5]! : 255;
  if (bitmapIndicator === 0) {
    const bitmap = secs.s6!.subarray(6);
    let k = 0;
    for (let i = 0; i < totalPoints; i++) {
      const present = (bitmap[i >> 3]! >> (7 - (i & 7))) & 1;
      values[i] = present ? (reference + ifld[k++]! * bscale) / dscale : NaN;
    }
  } else if (bitmapIndicator === 255) {
    for (let i = 0; i < totalPoints; i++) {
      values[i] = (reference + ifld[i]! * bscale) / dscale;
    }
  } else {
    throw new GribDecodeError(`Unsupported bitmap indicator ${bitmapIndicator}`);
  }

  return {
    values,
    grid,
    numGridPoints: totalPoints,
    discipline: secs.discipline,
    parameterCategory: secs.s4 ? secs.s4[9]! : 255,
    parameterNumber: secs.s4 ? secs.s4[10]! : 255,
    referenceTime: parseReferenceTime(secs.s1),
    drsTemplate,
  };
}
