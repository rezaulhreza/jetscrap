import { PLAYER_H, PLAYER_W } from './constants';
import type { MapDef } from './maps';
import { boxOverlapsRect } from './physics';

export interface Waypoint {
  x: number;
  y: number;
  /** True when a surface is close below, so the bot can stand here without fuel. */
  supported: boolean;
}

/**
 * Coarse navigation grid for bots. Each cell is one unit; a cell is free when a
 * standing player box with its feet at the cell bottom fits there. Bots can fly with
 * the jetpack, so all free neighbours connect, but unsupported (mid-air) cells cost more
 * so bots prefer to walk and save fuel. Hazard cells cost much more.
 */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly y0: number;
  private free: Uint8Array;
  private cost: Float32Array;
  private supported: Uint8Array;

  constructor(readonly map: MapDef) {
    this.y0 = Math.floor(map.killY) + 2;
    this.cols = Math.ceil(map.width);
    this.rows = Math.ceil(map.height - PLAYER_H) - this.y0;
    const n = this.cols * this.rows;
    this.free = new Uint8Array(n);
    this.cost = new Float32Array(n);
    this.supported = new Uint8Array(n);
    const surfaces = [...map.solids, ...map.platforms];
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const k = j * this.cols + i;
        const fx = i + 0.5;
        const fy = this.y0 + j;
        const left = fx - PLAYER_W / 2 - 0.05;
        if (map.solids.some((r) => boxOverlapsRect(left, fy, PLAYER_W + 0.1, PLAYER_H, r))) continue;
        this.free[k] = 1;
        const sup = surfaces.some((r) => {
          const top = r.y + r.h;
          return fx + 0.3 > r.x && fx - 0.3 < r.x + r.w && top <= fy + 0.01 && top > fy - 1.6;
        });
        this.supported[k] = sup ? 1 : 0;
        const hazard = map.hazards.some((h) => boxOverlapsRect(left, fy - 0.6, PLAYER_W + 0.1, PLAYER_H, h));
        this.cost[k] = (sup ? 1 : 2.2) + (hazard ? 60 : 0);
      }
    }
  }

  private index(x: number, y: number): number {
    const i = Math.floor(x);
    const j = Math.floor(y + 0.25) - this.y0;
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return -1;
    return j * this.cols + i;
  }

  /** Nearest free cell to a world point, searching outward a few cells. */
  nearestFree(x: number, y: number): number {
    const k = this.index(x, y);
    if (k >= 0 && this.free[k]) return k;
    const ci = Math.floor(x);
    const cj = Math.floor(y + 0.25) - this.y0;
    for (let r = 1; r <= 4; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) continue;
          const kk = j * this.cols + i;
          if (this.free[kk]) return kk;
        }
      }
    }
    return -1;
  }

  isSupported(x: number, y: number): boolean {
    const k = this.index(x, y);
    return k >= 0 && this.supported[k] === 1;
  }

  /** A* from one world point to another. Returns waypoints (feet positions) or null. */
  findPath(sx: number, sy: number, tx: number, ty: number, maxNodes = 4000): Waypoint[] | null {
    const start = this.nearestFree(sx, sy);
    const goal = this.nearestFree(tx, ty);
    if (start < 0 || goal < 0) return null;
    const cols = this.cols;
    const gi = goal % cols;
    const gj = (goal / cols) | 0;
    const g = new Map<number, number>([[start, 0]]);
    const came = new Map<number, number>();
    const heap = new MinHeap();
    const h = (k: number) => Math.hypot((k % cols) - gi, ((k / cols) | 0) - gj);
    heap.push(start, h(start));
    const closed = new Set<number>();
    let expanded = 0;
    while (heap.size > 0) {
      const cur = heap.pop();
      if (cur === goal) return this.reconstruct(came, cur);
      if (closed.has(cur)) continue;
      closed.add(cur);
      if (++expanded > maxNodes) break;
      const ci = cur % cols;
      const cj = (cur / cols) | 0;
      const gc = g.get(cur)!;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di;
          const nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= this.rows) continue;
          const nk = nj * cols + ni;
          if (!this.free[nk] || closed.has(nk)) continue;
          if (di && dj && (!this.free[cj * cols + ni] || !this.free[nj * cols + ci])) continue;
          // Rising costs fuel; falling is cheap.
          const vertical = dj > 0 ? 1.4 : dj < 0 ? 0.7 : 1;
          const step = (di && dj ? 1.41 : 1) * this.cost[nk] * vertical;
          const ng = gc + step;
          if (ng < (g.get(nk) ?? Infinity)) {
            g.set(nk, ng);
            came.set(nk, cur);
            heap.push(nk, ng + h(nk));
          }
        }
      }
    }
    return null;
  }

  private reconstruct(came: Map<number, number>, end: number): Waypoint[] {
    const out: Waypoint[] = [];
    let k: number | undefined = end;
    while (k !== undefined) {
      out.push({ x: (k % this.cols) + 0.5, y: this.y0 + ((k / this.cols) | 0), supported: this.supported[k] === 1 });
      k = came.get(k);
    }
    return out.reverse();
  }
}

class MinHeap {
  private keys: number[] = [];
  private pri: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, p: number): void {
    const keys = this.keys;
    const pri = this.pri;
    let i = keys.length;
    keys.push(key);
    pri.push(p);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pri[parent] <= p) break;
      keys[i] = keys[parent];
      pri[i] = pri[parent];
      i = parent;
    }
    keys[i] = key;
    pri[i] = p;
  }

  pop(): number {
    const keys = this.keys;
    const pri = this.pri;
    const top = keys[0];
    const lastK = keys.pop()!;
    const lastP = pri.pop()!;
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mp = lastP;
        if (l < n && pri[l] < mp) {
          m = l;
          mp = pri[l];
        }
        if (r < n && pri[r] < mp) m = r;
        if (m === i) break;
        keys[i] = keys[m];
        pri[i] = pri[m];
        i = m;
      }
      keys[i] = lastK;
      pri[i] = lastP;
    }
    return top;
  }
}

const cache = new Map<string, NavGrid>();

export function navFor(map: MapDef): NavGrid {
  let g = cache.get(map.id);
  if (!g) {
    g = new NavGrid(map);
    cache.set(map.id, g);
  }
  return g;
}
