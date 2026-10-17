import type { ItemKind } from './maps';
import type { WeaponId, WeaponState } from './weapons';

export type Mode = 'ffa' | 'tdm';
export type Difficulty = 'easy' | 'normal' | 'hard' | 'elite';
export type Phase = 'countdown' | 'live' | 'ended';

export interface MatchSettings {
  mode: Mode;
  map: string;
  /** Match length in seconds. */
  timeLimit: number;
  killLimit: number;
  bots: number;
  difficulty: Difficulty;
}

export const DEFAULT_SETTINGS: MatchSettings = {
  mode: 'ffa',
  map: 'foundry',
  timeLimit: 300,
  killLimit: 20,
  bots: 5,
  difficulty: 'normal',
};

export const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard', 'elite'];
export const TIME_LIMITS = [120, 180, 300, 480, 600];
export const KILL_LIMITS = [10, 15, 20, 30, 50];

/** One fixed-step input sample. `b` holds Btn bits; `mx` is -1, 0 or 1; `aim` is radians. */
export interface InputFrame {
  seq: number;
  b: number;
  mx: number;
  aim: number;
}

export const IDLE_INPUT: InputFrame = { seq: 0, b: 0, mx: 0, aim: 0 };

export interface DamageEntry {
  by: number;
  dmg: number;
  t: number;
}

export interface Player {
  id: number;
  name: string;
  /** 0 or 1 in team matches, -1 in free-for-all. */
  team: number;
  /** Colour slot for free-for-all. */
  color: number;
  bot: boolean;

  x: number;
  y: number;
  /** Position at the start of the current tick, for render interpolation. */
  px: number;
  py: number;
  vx: number;
  vy: number;
  grounded: boolean;
  jetting: boolean;
  dropTimer: number;
  aim: number;
  facing: number;

  hp: number;
  armor: number;
  fuel: number;
  fuelDelay: number;
  alive: boolean;
  respawnTimer: number;
  protect: number;

  primary: WeaponState | null;
  secondary: WeaponState;
  /** 0 = primary, 1 = secondary. */
  slot: number;
  cooldown: number;
  reloadTimer: number;
  swapTimer: number;
  grenades: number;
  grenadeCd: number;
  overdrive: number;
  haste: number;
  prevButtons: number;

  kills: number;
  deaths: number;
  assists: number;
  score: number;
  streak: number;
  damageLog: DamageEntry[];
  lastHitBy: number;
  lastHitTime: number;
  /** Seconds since this player last took damage, for hit flashes. */
  hurtTime: number;
}

export type KillCause = WeaponId | 'grenade' | 'hazard' | 'fall';

export type GameEvent =
  | { k: 'shot'; p: number; w: WeaponId; x: number; y: number; a: number }
  | { k: 'bullet'; id: number; p: number; w: WeaponId; x: number; y: number; vx: number; vy: number; life: number }
  | { k: 'impact'; id: number; x: number; y: number; flesh: boolean }
  | { k: 'hit'; p: number; by: number; d: number; x: number; y: number; head: boolean }
  | { k: 'kill'; p: number; by: number; w: KillCause; as: number; head: boolean; streak: number }
  | { k: 'boom'; x: number; y: number; r: number }
  | { k: 'pickup'; p: number; kind: ItemKind; w?: WeaponId }
  | { k: 'spawn'; p: number; x: number; y: number }
  | { k: 'reload'; p: number }
  | { k: 'throw'; p: number }
  | { k: 'swap'; p: number }
  | { k: 'phase'; phase: Phase };

export interface PickupState {
  id: number;
  kind: ItemKind;
  weapon?: WeaponId;
  x: number;
  y: number;
  active: boolean;
  dropped: boolean;
}

export interface HeavyProjectile {
  id: number;
  kind: 'rocket' | 'grenade';
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds until a grenade explodes. */
  life: number;
}

export interface MatchState {
  phase: Phase;
  mode: Mode;
  /** Seconds left in the current phase. */
  timeLeft: number;
  killLimit: number;
  teamScores: [number, number];
  /** Winning player id, winning team, or -1 for a draw. Set when the phase is 'ended'. */
  winner: number;
}

export interface ResultRow {
  id: number;
  name: string;
  team: number;
  color: number;
  bot: boolean;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
}
