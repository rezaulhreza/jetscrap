import {
  AIR_ACCEL, Btn, DROP_TIME, DT, FUEL_DRAIN, FUEL_MAX, FUEL_REGEN_AIR, FUEL_REGEN_DELAY, FUEL_REGEN_GROUND,
  GRAVITY, GRENADE_COOLDOWN, GROUND_ACCEL, HASTE_MULT, JET_ACCEL, JET_MAX_UP, JUMP_SPEED, MAX_FALL, MAX_HEALTH,
  PLAYER_H, PLAYER_W, RUN_SPEED, SPAWN_PROTECT, START_GRENADES,
} from './constants';
import type { MapDef } from './maps';
import { approach, clamp, moveBody } from './physics';
import type { GameEvent, InputFrame, Player } from './types';
import { WEAPONS, freshWeapon, type WeaponDef, type WeaponState } from './weapons';

/** What a player step needs from its surroundings. The server and client prediction supply different versions. */
export interface PlayerCtx {
  map: MapDef;
  /** During the countdown players can aim but not move or shoot. */
  frozen: boolean;
  rand(): number;
  fire(p: Player, def: WeaponDef, aim: number): void;
  grenade(p: Player): void;
  emit(e: GameEvent): void;
}

export function newPlayer(id: number, name: string, team: number, color: number, bot: boolean): Player {
  return {
    id, name, team, color, bot,
    x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, grounded: false, jetting: false, dropTimer: 0, aim: 0, facing: 1,
    hp: MAX_HEALTH, armor: 0, fuel: FUEL_MAX, fuelDelay: 0, alive: false, respawnTimer: 0, protect: 0,
    primary: freshWeapon('rifle'), secondary: freshWeapon('pistol'), slot: 0,
    cooldown: 0, reloadTimer: 0, swapTimer: 0, grenades: START_GRENADES, grenadeCd: 0, overdrive: 0, haste: 0,
    prevButtons: 0,
    kills: 0, deaths: 0, assists: 0, score: 0, streak: 0, damageLog: [], lastHitBy: 0, lastHitTime: -99, hurtTime: 99,
  };
}

/** Restores a player to a fresh loadout at (x, y). */
export function spawnPlayer(p: Player, x: number, y: number): void {
  p.x = p.px = x;
  p.y = p.py = y;
  p.vx = p.vy = 0;
  p.grounded = false;
  p.jetting = false;
  p.hp = MAX_HEALTH;
  p.armor = 0;
  p.fuel = FUEL_MAX;
  p.fuelDelay = 0;
  p.alive = true;
  p.protect = SPAWN_PROTECT;
  p.primary = freshWeapon('rifle');
  p.secondary = freshWeapon('pistol');
  p.slot = 0;
  p.cooldown = 0.3;
  p.reloadTimer = 0;
  p.swapTimer = 0;
  p.grenades = START_GRENADES;
  p.grenadeCd = 0;
  p.overdrive = 0;
  p.haste = 0;
  p.streak = 0;
  p.damageLog = [];
  p.lastHitBy = 0;
  p.hurtTime = 99;
}

export function activeWeapon(p: Player): WeaponState {
  return p.slot === 0 && p.primary ? p.primary : p.secondary;
}

function canReload(w: WeaponState): boolean {
  const def = WEAPONS[w.id];
  return w.mag < def.mag && (def.secondary || w.reserve > 0);
}

function finishReload(w: WeaponState): void {
  const def = WEAPONS[w.id];
  const need = def.mag - w.mag;
  if (def.secondary) {
    w.mag = def.mag;
    return;
  }
  const take = Math.min(need, w.reserve);
  w.mag += take;
  w.reserve -= take;
}

/**
 * Advances one living player by one fixed tick: timers, movement, jetpack, weapons.
 * Returns the buttons newly pressed this tick, so the caller can act on interaction presses.
 */
export function stepPlayer(p: Player, input: InputFrame, ctx: PlayerCtx): number {
  const pressed = input.b & ~p.prevButtons;
  p.prevButtons = input.b;
  p.px = p.x;
  p.py = p.y;
  p.hurtTime += DT;
  if (!p.alive) return 0;

  p.aim = Number.isFinite(input.aim) ? clamp(input.aim, -Math.PI, Math.PI) : p.aim;
  p.facing = Math.cos(p.aim) >= 0 ? 1 : -1;
  p.protect = Math.max(0, p.protect - DT);
  p.overdrive = Math.max(0, p.overdrive - DT);
  p.haste = Math.max(0, p.haste - DT);
  p.cooldown = Math.max(0, p.cooldown - DT);
  p.swapTimer = Math.max(0, p.swapTimer - DT);
  p.grenadeCd = Math.max(0, p.grenadeCd - DT);
  p.dropTimer = Math.max(0, p.dropTimer - DT);

  if (ctx.frozen) {
    p.vx = 0;
    p.jetting = false;
    return pressed;
  }

  // Movement.
  const mx = clamp(Math.round(input.mx), -1, 1);
  const speed = RUN_SPEED * (p.haste > 0 ? HASTE_MULT : 1);
  p.vx = approach(p.vx, mx * speed, (p.grounded ? GROUND_ACCEL : AIR_ACCEL) * DT);

  const up = (input.b & Btn.Up) !== 0;
  p.jetting = false;
  if (up && p.grounded && (pressed & Btn.Up)) {
    p.vy = JUMP_SPEED;
    p.grounded = false;
  } else if (up && p.fuel > 0) {
    if (p.vy < JET_MAX_UP) p.vy = Math.min(JET_MAX_UP, p.vy + JET_ACCEL * DT);
    if (p.haste <= 0) p.fuel = Math.max(0, p.fuel - FUEL_DRAIN * DT);
    p.fuelDelay = FUEL_REGEN_DELAY;
    p.jetting = true;
  }
  if (!p.jetting) {
    p.fuelDelay -= DT;
    if (p.fuelDelay <= 0) p.fuel = Math.min(FUEL_MAX, p.fuel + (p.grounded ? FUEL_REGEN_GROUND : FUEL_REGEN_AIR) * DT);
  }
  p.vy = Math.max(-MAX_FALL, p.vy - GRAVITY * DT);
  if (input.b & Btn.Down) p.dropTimer = DROP_TIME;
  moveBody(p, ctx.map, DT, PLAYER_W, PLAYER_H, p.dropTimer > 0);

  // Weapons.
  if ((pressed & Btn.Swap) && p.primary) {
    p.slot = p.slot === 0 ? 1 : 0;
    p.swapTimer = 0.28;
    p.reloadTimer = 0;
    ctx.emit({ k: 'swap', p: p.id });
  }
  if (p.slot === 0 && !p.primary) p.slot = 1;
  const w = activeWeapon(p);

  if (p.reloadTimer > 0) {
    p.reloadTimer -= DT;
    if (p.reloadTimer <= 0) {
      p.reloadTimer = 0;
      finishReload(w);
    }
  } else if ((pressed & Btn.Reload) && canReload(w)) {
    p.reloadTimer = WEAPONS[w.id].reload;
    ctx.emit({ k: 'reload', p: p.id });
  }

  if ((input.b & Btn.Fire) && p.cooldown <= 0 && p.reloadTimer <= 0 && p.swapTimer <= 0) {
    const def = WEAPONS[w.id];
    if (w.mag > 0) {
      w.mag--;
      p.cooldown = def.interval;
      p.protect = 0;
      ctx.fire(p, def, p.aim);
      if (w.mag === 0 && canReload(w)) {
        p.reloadTimer = def.reload;
        ctx.emit({ k: 'reload', p: p.id });
      }
    } else if (canReload(w)) {
      p.reloadTimer = def.reload;
      ctx.emit({ k: 'reload', p: p.id });
    } else if (p.slot === 0) {
      // Primary is dry: fall back to the pistol.
      p.slot = 1;
      p.swapTimer = 0.28;
      ctx.emit({ k: 'swap', p: p.id });
    }
  }

  if ((pressed & Btn.Grenade) && p.grenades > 0 && p.grenadeCd <= 0) {
    p.grenades--;
    p.grenadeCd = GRENADE_COOLDOWN;
    p.protect = 0;
    ctx.grenade(p);
    ctx.emit({ k: 'throw', p: p.id });
  }
  return pressed;
}

/** Fields that client prediction copies from the authoritative state before replaying inputs. */
export const PREDICTED_FIELDS = [
  'x', 'y', 'vx', 'vy', 'grounded', 'jetting', 'dropTimer', 'fuel', 'fuelDelay', 'alive', 'protect',
  'slot', 'cooldown', 'reloadTimer', 'swapTimer', 'grenades', 'grenadeCd', 'overdrive', 'haste', 'prevButtons',
  'hp', 'armor', 'respawnTimer',
] as const;

export type PredictedState = Pick<Player, (typeof PREDICTED_FIELDS)[number] | 'primary' | 'secondary'>;

export function capturePredicted(p: Player): PredictedState {
  const out: Record<string, unknown> = {};
  for (const f of PREDICTED_FIELDS) out[f] = p[f];
  out.primary = p.primary ? { ...p.primary } : null;
  out.secondary = { ...p.secondary };
  return out as unknown as PredictedState;
}

export function applyPredicted(p: Player, s: PredictedState): void {
  Object.assign(p, s);
  p.primary = s.primary ? { ...s.primary } : null;
  p.secondary = { ...s.secondary };
}
