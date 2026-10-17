// Tuning values shared by the client simulation, the bots and the authoritative server.
// One world unit is roughly one metre. Y points up; a player's (x, y) is the centre of their feet.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
/** The server sends a snapshot every N ticks (20 Hz). */
export const SNAPSHOT_EVERY = 3;

export const PLAYER_W = 0.8;
export const PLAYER_H = 1.8;
/** Shoulder height above the feet; shots and grenades start here. */
export const SHOULDER_Y = 1.3;
/** Hits above this height (relative to the feet) count as head shots. */
export const HEAD_Y = 1.42;

export const GRAVITY = 32;
export const MAX_FALL = 26;
export const RUN_SPEED = 8.5;
export const GROUND_ACCEL = 80;
export const AIR_ACCEL = 34;
export const JUMP_SPEED = 11.5;
export const JET_ACCEL = 60;
export const JET_MAX_UP = 9.5;
export const FUEL_MAX = 100;
export const FUEL_DRAIN = 42;
export const FUEL_REGEN_GROUND = 70;
export const FUEL_REGEN_AIR = 14;
export const FUEL_REGEN_DELAY = 0.35;
/** Seconds that one-way platforms ignore a player after they press down. */
export const DROP_TIME = 0.25;

export const MAX_HEALTH = 100;
export const MAX_ARMOR = 100;
/** Fraction of incoming damage that armour absorbs while it lasts. */
export const ARMOR_ABSORB = 0.6;
export const RESPAWN_TIME = 3;
export const SPAWN_PROTECT = 2;
export const COUNTDOWN_TIME = 3;
export const ASSIST_WINDOW = 8;
export const ASSIST_MIN_DAMAGE = 20;
/** A hazard or self-inflicted death within this window credits the last attacker. */
export const CREDIT_WINDOW = 5;

export const MAX_GRENADES = 3;
export const START_GRENADES = 2;
export const GRENADE_FUSE = 2.2;
export const GRENADE_SPEED = 19;
export const GRENADE_DAMAGE = 95;
export const GRENADE_RADIUS = 3.6;
export const GRENADE_COOLDOWN = 0.7;

export const POWERUP_TIME = 10;
export const OVERDRIVE_MULT = 1.5;
export const HASTE_MULT = 1.3;
export const SELF_DAMAGE_MULT = 0.5;

export const MAX_PLAYERS = 12;
export const MAX_HUMANS = 8;
export const MAX_PROJECTILES = 260;
export const MAX_DROPPED = 10;
export const DROP_LIFETIME = 20;

/** Input button bits. */
export const Btn = {
  Up: 1,
  Down: 2,
  Fire: 4,
  Reload: 8,
  Swap: 16,
  Interact: 32,
  Grenade: 64,
} as const;

export const TEAM_NAMES = ['Ember', 'Tide'] as const;
