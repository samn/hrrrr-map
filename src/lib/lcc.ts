/**
 * Lambert conformal conic projection on a sphere, as used by the HRRR grid,
 * plus grid <-> lon/lat transforms anchored at the grid's first point.
 */

export interface LccGrid {
  nx: number;
  ny: number;
  /** Grid spacing, metres. */
  dx: number;
  dy: number;
  /** First grid point (south-west corner), degrees. Longitude may be 0..360. */
  la1: number;
  lo1: number;
  /** Standard parallels and orientation longitude, degrees. */
  latin1: number;
  latin2: number;
  lov: number;
  /** Earth radius, metres. */
  earthRadiusM: number;
}

/** The operational HRRR CONUS grid (also parsed from GRIB at runtime). */
export const HRRR_GRID: LccGrid = {
  nx: 1799,
  ny: 1059,
  dx: 3000,
  dy: 3000,
  la1: 21.138123,
  lo1: 237.280472,
  latin1: 38.5,
  latin2: 38.5,
  lov: 262.5,
  earthRadiusM: 6371229,
};

const DEG = Math.PI / 180;

export interface LccProjection {
  forward(lonDeg: number, latDeg: number): [x: number, y: number];
  inverse(x: number, y: number): [lonDeg: number, latDeg: number];
}

export function makeLccProjection(grid: LccGrid): LccProjection {
  const phi1 = grid.latin1 * DEG;
  const phi2 = grid.latin2 * DEG;
  const lam0 = grid.lov * DEG;
  const R = grid.earthRadiusM;

  const n =
    Math.abs(phi1 - phi2) < 1e-10
      ? Math.sin(phi1)
      : Math.log(Math.cos(phi1) / Math.cos(phi2)) /
        Math.log(Math.tan(Math.PI / 4 + phi2 / 2) / Math.tan(Math.PI / 4 + phi1 / 2));
  const F = (Math.cos(phi1) * Math.tan(Math.PI / 4 + phi1 / 2) ** n) / n;
  const rho0 = (R * F) / Math.tan(Math.PI / 4 + phi1 / 2) ** n;

  function forward(lonDeg: number, latDeg: number): [number, number] {
    const phi = latDeg * DEG;
    let dlam = lonDeg * DEG - lam0;
    // Wrap to (-pi, pi] so 0..360 and -180..180 longitudes behave identically.
    while (dlam > Math.PI) dlam -= 2 * Math.PI;
    while (dlam < -Math.PI) dlam += 2 * Math.PI;
    const rho = (R * F) / Math.tan(Math.PI / 4 + phi / 2) ** n;
    const theta = n * dlam;
    return [rho * Math.sin(theta), rho0 - rho * Math.cos(theta)];
  }

  function inverse(x: number, y: number): [number, number] {
    const sign = n >= 0 ? 1 : -1;
    const rho = sign * Math.hypot(x, rho0 - y);
    const theta = Math.atan2(sign * x, sign * (rho0 - y));
    const lat = (2 * Math.atan(((R * F) / rho) ** (1 / n)) - Math.PI / 2) / DEG;
    let lon = (lam0 + theta / n) / DEG;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    return [lon, lat];
  }

  return { forward, inverse };
}

export interface GridTransform {
  /**
   * Fractional grid position for a lon/lat. `col` counts east from the west
   * edge; `row` counts south from the NORTH edge (north-up row order,
   * matching decoded chunk data). Positions outside the grid fall outside
   * [0, nx-1] x [0, ny-1].
   */
  lonLatToGrid(lonDeg: number, latDeg: number): [col: number, row: number];
  /** Lon/lat of a fractional grid position (north-up row order). */
  gridToLonLat(col: number, row: number): [lonDeg: number, latDeg: number];
}

export function makeGridTransform(grid: LccGrid): GridTransform {
  const proj = makeLccProjection(grid);
  const [x1, y1] = proj.forward(grid.lo1, grid.la1);

  return {
    lonLatToGrid(lonDeg, latDeg) {
      const [x, y] = proj.forward(lonDeg, latDeg);
      const col = (x - x1) / grid.dx;
      const jSouth = (y - y1) / grid.dy;
      return [col, grid.ny - 1 - jSouth];
    },
    gridToLonLat(col, row) {
      const jSouth = grid.ny - 1 - row;
      return proj.inverse(x1 + col * grid.dx, y1 + jSouth * grid.dy);
    },
  };
}
