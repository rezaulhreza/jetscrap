import { Btn, PLAYER_H } from './constants';
import type { ItemKind } from './maps';
import type { PredictedState } from './player';
import type { GameEvent, HeavyProjectile, MatchSettings, MatchState, PickupState, Player, ResultRow } from './types';
import type { WeaponId } from './weapons';

export const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;
export const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;

export function randomRoomCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) s += ROOM_CODE_CHARS[Math.floor(rand() * ROOM_CODE_CHARS.length)];
  return s;
}

export function cleanName(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .trim()
    .slice(0, 16);
  return s || 'Player';
}

export type RoomPhase = 'lobby' | 'match' | 'results';

export interface MemberInfo {
  cid: string;
  name: string;
  team: number;
  connected: boolean;
}

export interface RosterEntry {
  id: number;
  name: string;
  team: number;
  color: number;
  bot: boolean;
}

/** Compact player record: [id, x, y, vx, vy, aim, hp, armor, flags, weapon, fuel]. */
export type PlayerSnap = [number, number, number, number, number, number, number, number, number, number, number];
/** Compact pickup record: [id, kind, weapon, x, y, flags]. */
export type PickupSnap = [number, number, number, number, number, number];
/** Score record: [id, kills, deaths, assists, score]. */
export type ScoreSnap = [number, number, number, number, number];

export type ClientMsg =
  | { t: 'settings'; s: Partial<MatchSettings> }
  | { t: 'team'; team: number }
  | { t: 'start' }
  | { t: 'lobby' }
  | { t: 'leave' }
  | { t: 'in'; i: [number, number, number, number][] }
  | { t: 'ping'; c: number };

export type ErrorCode = 'not_found' | 'taken' | 'full' | 'bad_request' | 'kicked';

export type ServerMsg =
  | { t: 'room'; code: string; you: string; host: string; phase: RoomPhase; settings: MatchSettings; members: MemberInfo[] }
  | { t: 'match'; settings: MatchSettings; you: number; roster: RosterEntry[] }
  | { t: 'roster'; roster: RosterEntry[] }
  | {
      t: 'snap';
      tick: number;
      ack: number;
      me: PredictedState | null;
      p: PlayerSnap[];
      h: HeavyProjectile[];
      k: PickupSnap[];
      m: MatchState;
      sc: ScoreSnap[];
      ev: GameEvent[];
    }
  | { t: 'end'; results: ResultRow[]; match: MatchState }
  | { t: 'pong'; c: number }
  | { t: 'notice'; msg: string }
  | { t: 'error'; code: ErrorCode; msg: string };

export const FLAG = {
  alive: 1,
  grounded: 2,
  jetting: 4,
  reloading: 8,
  protect: 16,
  overdrive: 32,
  haste: 64,
} as const;

export const WEAPON_INDEX: WeaponId[] = ['pistol', 'rifle', 'shotgun', 'sniper', 'rocket'];
export const ITEM_INDEX: ItemKind[] = ['health', 'armor', 'ammo', 'grenades', 'overdrive', 'haste', 'weapon'];

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function encodePlayer(p: Player): PlayerSnap {
  let f = 0;
  if (p.alive) f |= FLAG.alive;
  if (p.grounded) f |= FLAG.grounded;
  if (p.jetting) f |= FLAG.jetting;
  if (p.reloadTimer > 0) f |= FLAG.reloading;
  if (p.protect > 0) f |= FLAG.protect;
  if (p.overdrive > 0) f |= FLAG.overdrive;
  if (p.haste > 0) f |= FLAG.haste;
  const w = p.slot === 0 && p.primary ? p.primary.id : p.secondary.id;
  return [p.id, r2(p.x), r2(p.y), r2(p.vx), r2(p.vy), r3(p.aim), Math.ceil(p.hp), Math.ceil(p.armor), f, WEAPON_INDEX.indexOf(w), Math.round(p.fuel)];
}

export function encodePickup(k: PickupState): PickupSnap {
  return [k.id, ITEM_INDEX.indexOf(k.kind), k.weapon ? WEAPON_INDEX.indexOf(k.weapon) : -1, r2(k.x), r2(k.y), (k.active ? 1 : 0) | (k.dropped ? 2 : 0)];
}

export function decodePickup(s: PickupSnap): PickupState {
  return { id: s[0], kind: ITEM_INDEX[s[1]], weapon: s[2] >= 0 ? WEAPON_INDEX[s[2]] : undefined, x: s[3], y: s[4], active: (s[5] & 1) !== 0, dropped: (s[5] & 2) !== 0 };
}

/** JSON with numbers rounded to three decimals, to keep snapshots small. */
export function packJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === 'number' ? (Number.isFinite(val) ? Math.round(val * 1000) / 1000 : 0) : val));
}

/** Validates one input tuple from the wire. Returns null when malformed. */
export function readInput(t: unknown): { seq: number; b: number; mx: number; aim: number } | null {
  if (!Array.isArray(t) || t.length !== 4) return null;
  const [seq, b, mx, aim] = t;
  if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(b) || !Number.isFinite(mx) || !Number.isFinite(aim)) return null;
  const allButtons = Btn.Up | Btn.Down | Btn.Fire | Btn.Reload | Btn.Swap | Btn.Interact | Btn.Grenade;
  return { seq, b: b & allButtons, mx: mx > 0 ? 1 : mx < 0 ? -1 : 0, aim: Math.max(-Math.PI, Math.min(Math.PI, aim)) };
}

/** Height of a player's centre, used by renderers for labels. */
export const LABEL_Y = PLAYER_H + 0.55;
