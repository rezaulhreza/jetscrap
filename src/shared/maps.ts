import type { WeaponId } from './weapons';

/** Axis-aligned box. (x, y) is the bottom-left corner. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type HazardKind = 'acid' | 'shock';

export interface Hazard extends Rect {
  kind: HazardKind;
  /** Damage per second. */
  dps: number;
}

export type ItemKind = 'health' | 'armor' | 'ammo' | 'grenades' | 'overdrive' | 'haste' | 'weapon';

export interface ItemSpawn {
  x: number;
  y: number;
  kind: ItemKind;
  weapon?: WeaponId;
}

export interface SpawnPoint {
  x: number;
  y: number;
  /** Preferred team in team matches; undefined means neutral. */
  team?: 0 | 1;
}

export interface MapTheme {
  style: 'foundry' | 'city' | 'arctic';
  skyTop: string;
  skyBottom: string;
  fog: string;
  solid: string;
  trim: string;
  platform: string;
  accent: string;
  hazard: string;
  sun: string;
  ambient: string;
}

export interface MapDef {
  id: string;
  name: string;
  blurb: string;
  width: number;
  height: number;
  /** Players below this height die (bottomless drops). */
  killY: number;
  solids: Rect[];
  /** One-way platforms: solid from above, passable from below and when dropping. */
  platforms: Rect[];
  hazards: Hazard[];
  spawns: SpawnPoint[];
  items: ItemSpawn[];
  theme: MapTheme;
}

const PLATFORM_T = 0.5;

/** Solid block by bottom-left corner. */
const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
/** Solid slab whose top surface is at `top`. */
const S = (x: number, top: number, w: number, h = 1.5): Rect => ({ x, y: top - h, w, h });
/** One-way platform whose top surface is at `top`. */
const P = (x: number, top: number, w: number): Rect => ({ x, y: top - PLATFORM_T, w, h: PLATFORM_T });

interface MapSource extends Omit<MapDef, 'solids' | 'platforms' | 'hazards' | 'spawns' | 'items'> {
  /** Left-half geometry; mirrored across the centre line. */
  solids: Rect[];
  platforms: Rect[];
  hazards: Hazard[];
  spawns: SpawnPoint[];
  items: ItemSpawn[];
  /** Geometry on the centre line, not mirrored. */
  center: { solids?: Rect[]; platforms?: Rect[]; hazards?: Hazard[]; spawns?: SpawnPoint[]; items?: ItemSpawn[] };
}

function mirrorRect<T extends Rect>(r: T, width: number): T {
  return { ...r, x: width - r.x - r.w };
}

/** Builds a symmetric map: left-half pieces plus their mirror images, then the centre pieces and the outer walls. */
function build(src: MapSource): MapDef {
  const W = src.width;
  const H = src.height;
  const walls: Rect[] = [R(-4, src.killY - 40, 4, H - src.killY + 44), R(W, src.killY - 40, 4, H - src.killY + 44), R(-4, H, W + 8, 4)];
  const c = src.center;
  return {
    id: src.id,
    name: src.name,
    blurb: src.blurb,
    width: W,
    height: H,
    killY: src.killY,
    theme: src.theme,
    solids: [...walls, ...src.solids, ...src.solids.map((r) => mirrorRect(r, W)), ...(c.solids ?? [])],
    platforms: [...src.platforms, ...src.platforms.map((r) => mirrorRect(r, W)), ...(c.platforms ?? [])],
    hazards: [...src.hazards, ...src.hazards.map((r) => mirrorRect(r, W)), ...(c.hazards ?? [])],
    spawns: [
      ...src.spawns.map((s) => ({ ...s, team: 0 as const })),
      ...src.spawns.map((s) => ({ x: W - s.x, y: s.y, team: 1 as const })),
      ...(c.spawns ?? []),
    ],
    items: [...src.items, ...src.items.map((i) => ({ ...i, x: W - i.x })), ...(c.items ?? [])],
  };
}

const foundry = build({
  id: 'foundry',
  name: 'Cinder Foundry',
  blurb: 'Stacked smelting floors over open acid vats. Close quarters low, long sightlines up top.',
  width: 100,
  height: 50,
  killY: -6,
  theme: {
    style: 'foundry',
    skyTop: '#1d110d', skyBottom: '#6e3418', fog: '#3b1f14',
    solid: '#6f6457', trim: '#e09a3c', platform: '#8c7864', accent: '#ff8a2a', hazard: '#a6ff3d',
    sun: '#ffc48a', ambient: '#6a4a3a',
  },
  solids: [
    R(0, -4, 30, 6),
    R(30, -4, 8, 4),
    R(12, 2, 2.2, 2.2),
    S(6, 12, 20),
    S(8, 30, 16),
    S(34, 27, 12),
  ],
  platforms: [P(29, 7, 10), P(0, 8, 5), P(18, 19, 12), P(2, 22, 10), P(26, 37, 10), P(4, 40, 8)],
  hazards: [{ ...R(30, 0, 8, 1.2), kind: 'acid', dps: 60 }],
  spawns: [
    { x: 4, y: 2 }, { x: 22, y: 2 }, { x: 12, y: 12 }, { x: 24, y: 19 }, { x: 12, y: 30 }, { x: 7, y: 22 },
  ],
  items: [
    { x: 18, y: 12, kind: 'weapon', weapon: 'shotgun' },
    { x: 8, y: 40, kind: 'weapon', weapon: 'sniper' },
    { x: 2.5, y: 2, kind: 'health' },
    { x: 16, y: 30, kind: 'health' },
    { x: 22, y: 19, kind: 'armor' },
    { x: 41, y: 14, kind: 'ammo' },
    { x: 34, y: 7, kind: 'grenades' },
    { x: 43, y: 2, kind: 'weapon', weapon: 'rifle' },
  ],
  center: {
    solids: [R(38, -4, 24, 6), R(47, 2, 6, 5), S(38, 14, 24), R(46, 14, 8, 7), S(40, 42, 20)],
    platforms: [P(45, 32, 10)],
    spawns: [{ x: 42, y: 2 }, { x: 58, y: 2 }, { x: 50, y: 42 }],
    items: [
      { x: 50, y: 7, kind: 'weapon', weapon: 'rocket' },
      { x: 50, y: 42, kind: 'overdrive' },
      { x: 50, y: 32, kind: 'haste' },
    ],
  },
});

const spirefall = build({
  id: 'spirefall',
  name: 'Spirefall',
  blurb: 'Neon rooftops at dusk. Bridges and billboards over a long drop. Watch your fuel.',
  width: 104,
  height: 54,
  killY: -8,
  theme: {
    style: 'city',
    skyTop: '#15142e', skyBottom: '#d0706a', fog: '#3a2b4f',
    solid: '#7a84a3', trim: '#7fd6c8', platform: '#8b93b3', accent: '#ff4f9a', hazard: '#5cf4ff',
    sun: '#ffb39a', ambient: '#5a5680',
  },
  solids: [
    R(0, -30, 16, 44),
    R(22, -30, 14, 38),
    R(4, 14, 2, 2),
    R(28, 8, 1.6, 2.4),
    S(30, 30, 8, 1.2),
  ],
  platforms: [P(15, 11, 8), P(36, 14, 9), P(4, 24, 10), P(24, 20, 10), P(10, 36, 10), P(38, 40, 8), P(40, 27, 6)],
  hazards: [],
  spawns: [{ x: 9, y: 14 }, { x: 13, y: 14 }, { x: 32, y: 8 }, { x: 12, y: 24 }, { x: 29, y: 20 }, { x: 12, y: 36 }],
  items: [
    { x: 17, y: 36, kind: 'weapon', weapon: 'sniper' },
    { x: 33.5, y: 8, kind: 'weapon', weapon: 'shotgun' },
    { x: 2, y: 14, kind: 'health' },
    { x: 34, y: 30, kind: 'armor' },
    { x: 27, y: 20, kind: 'ammo' },
    { x: 43, y: 27, kind: 'grenades' },
    { x: 6, y: 24, kind: 'haste' },
  ],
  center: {
    solids: [R(46, -30, 12, 52)],
    platforms: [P(47, 34, 10), P(46, 46, 12)],
    hazards: [{ ...R(50.5, 22, 3, 0.6), kind: 'shock', dps: 45 }],
    spawns: [{ x: 47.5, y: 22 }, { x: 56.5, y: 22 }],
    items: [
      { x: 52, y: 34, kind: 'weapon', weapon: 'rocket' },
      { x: 52, y: 46, kind: 'overdrive' },
      { x: 48.5, y: 34, kind: 'health' },
    ],
  },
});

const frostline = build({
  id: 'frostline',
  name: 'Frostline Relay',
  blurb: 'A three-deck polar station. An electrified floor splits the hangar; shafts and catwalks go around it.',
  width: 100,
  height: 48,
  killY: -6,
  theme: {
    style: 'arctic',
    skyTop: '#0c1726', skyBottom: '#6f9cbc', fog: '#7f9db4',
    solid: '#b9c4cf', trim: '#2f86d6', platform: '#7d91a4', accent: '#3fb8ff', hazard: '#b5f2ff',
    sun: '#e8f4ff', ambient: '#6f88a3',
  },
  solids: [
    R(0, -4, 42, 7),
    R(14, 3, 2, 4),
    R(30, 3, 1.5, 3),
    R(0, 13, 6, 2),
    R(11, 13, 27, 2),
    R(22, 15, 2, 3),
    R(14, 25, 24, 2),
  ],
  platforms: [P(6, 8, 5), P(0, 22, 8), P(6, 34, 12), P(33, 21, 5)],
  hazards: [],
  spawns: [{ x: 3, y: 3 }, { x: 22, y: 3 }, { x: 35, y: 3 }, { x: 3, y: 15 }, { x: 18, y: 15 }, { x: 20, y: 27 }, { x: 12, y: 34 }],
  items: [
    { x: 10, y: 34, kind: 'weapon', weapon: 'sniper' },
    { x: 28, y: 15, kind: 'weapon', weapon: 'shotgun' },
    { x: 1.5, y: 3, kind: 'health' },
    { x: 34, y: 27, kind: 'health' },
    { x: 25, y: 27, kind: 'armor' },
    { x: 37, y: 3, kind: 'ammo' },
    { x: 8.5, y: 8, kind: 'grenades' },
    { x: 45, y: 20.5, kind: 'haste' },
    { x: 36, y: 39, kind: 'weapon', weapon: 'rifle' },
  ],
  center: {
    solids: [R(42, -4, 16, 6.5), R(42, 19, 16, 1.5), R(49, 20.5, 2, 2.5), R(30, 37, 40, 2)],
    platforms: [P(44, 9, 12)],
    hazards: [{ ...R(42, 2.5, 16, 0.6), kind: 'shock', dps: 55 }],
    spawns: [{ x: 40, y: 39 }, { x: 60, y: 39 }],
    items: [
      { x: 50, y: 39, kind: 'weapon', weapon: 'rocket' },
      { x: 50, y: 9, kind: 'overdrive' },
    ],
  },
});

export const MAPS: Record<string, MapDef> = { foundry, spirefall, frostline };
export const MAP_IDS = Object.keys(MAPS);

export function getMap(id: string): MapDef {
  return MAPS[id] ?? foundry;
}
