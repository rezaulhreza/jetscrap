import type { MapDef, Rect } from './maps';

const EPS = 1e-4;

export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
}

export function boxOverlapsRect(left: number, bottom: number, w: number, h: number, r: Rect): boolean {
  return left < r.x + r.w && left + w > r.x && bottom < r.y + r.h && bottom + h > r.y;
}

export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/**
 * Moves a box whose feet sit at (x, y) through the map, one axis at a time.
 * Solids block from every side. One-way platforms only block a falling body whose
 * feet started above the platform top, unless `ignorePlatforms` is set.
 */
export function moveBody(b: Body, map: MapDef, dt: number, w: number, h: number, ignorePlatforms: boolean): void {
  const hw = w / 2;

  let nx = b.x + b.vx * dt;
  for (const r of map.solids) {
    if (!boxOverlapsRect(nx - hw, b.y, w, h, r)) continue;
    if (b.vx > 0) nx = r.x - hw - EPS;
    else if (b.vx < 0) nx = r.x + r.w + hw + EPS;
    else nx = b.x;
    b.vx = 0;
  }
  b.x = nx;

  const prevY = b.y;
  let ny = b.y + b.vy * dt;
  let grounded = false;
  for (const r of map.solids) {
    if (!boxOverlapsRect(b.x - hw, ny, w, h, r)) continue;
    if (b.vy <= 0) {
      ny = r.y + r.h;
      grounded = true;
    } else {
      ny = r.y - h - EPS;
    }
    b.vy = 0;
  }
  if (!ignorePlatforms && b.vy <= 0) {
    for (const r of map.platforms) {
      const top = r.y + r.h;
      if (prevY >= top - EPS && ny < top && b.x + hw > r.x && b.x - hw < r.x + r.w) {
        ny = top;
        b.vy = 0;
        grounded = true;
      }
    }
  }
  b.y = ny;
  b.grounded = grounded;
}

/** True when the body stands on a one-way platform rather than on a solid. */
export function onPlatform(b: Body, map: MapDef, w: number): boolean {
  const hw = w / 2;
  for (const r of map.platforms) {
    if (Math.abs(b.y - (r.y + r.h)) < 0.02 && b.x + hw > r.x && b.x - hw < r.x + r.w) return true;
  }
  return false;
}

/**
 * Segment vs box intersection (slab method). Returns the entry fraction along the
 * segment in [0, 1], or -1 when the segment misses. A segment that starts inside
 * the box returns 0.
 */
export function segmentRect(x0: number, y0: number, dx: number, dy: number, rx: number, ry: number, rw: number, rh: number): number {
  let tmin = 0;
  let tmax = 1;
  if (Math.abs(dx) < 1e-9) {
    if (x0 < rx || x0 > rx + rw) return -1;
  } else {
    let t1 = (rx - x0) / dx;
    let t2 = (rx + rw - x0) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  if (Math.abs(dy) < 1e-9) {
    if (y0 < ry || y0 > ry + rh) return -1;
  } else {
    let t1 = (ry - y0) / dy;
    let t2 = (ry + rh - y0) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/** Fraction along the segment where it first enters a solid, or 1 when the path is clear. */
export function raySolids(map: MapDef, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let best = 1;
  for (const r of map.solids) {
    const t = segmentRect(x0, y0, dx, dy, r.x, r.y, r.w, r.h);
    if (t >= 0 && t < best) best = t;
  }
  return best;
}

/**
 * Like `raySolids`, but one-way platforms also stop the ray, from either side. Bullets,
 * rockets, blasts and sight use this. A platform that contains the start point is skipped,
 * so a player who jumps or drops through a platform can still shoot.
 */
export function rayShot(map: MapDef, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let best = raySolids(map, x0, y0, x1, y1);
  for (const r of map.platforms) {
    if (pointInRect(x0, y0, r)) continue;
    const t = segmentRect(x0, y0, dx, dy, r.x, r.y, r.w, r.h);
    if (t >= 0 && t < best) best = t;
  }
  return best;
}

export function lineOfSight(map: MapDef, x0: number, y0: number, x1: number, y1: number): boolean {
  return rayShot(map, x0, y0, x1, y1) >= 1;
}

export function pointInSolid(map: MapDef, x: number, y: number): boolean {
  for (const r of map.solids) if (pointInRect(x, y, r)) return true;
  return false;
}

/** Height of the first walkable surface at or below (x, y), or -Infinity. */
export function groundBelow(map: MapDef, x: number, y: number): number {
  let best = -Infinity;
  for (const r of [...map.solids, ...map.platforms]) {
    const top = r.y + r.h;
    if (x >= r.x && x <= r.x + r.w && top <= y + EPS && top > best) best = top;
  }
  return best;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function approach(v: number, target: number, step: number): number {
  if (v < target) return Math.min(v + step, target);
  if (v > target) return Math.max(v - step, target);
  return v;
}
