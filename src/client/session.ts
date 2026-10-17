import { DT, SHOULDER_Y } from '../shared/constants';
import { activeWeapon } from '../shared/player';
import { World } from '../shared/sim';
import type {
  GameEvent, HeavyProjectile, InputFrame, MatchSettings, MatchState, PickupState, Player, ResultRow,
} from '../shared/types';
import { WEAPONS, type WeaponId } from '../shared/weapons';

/** Everything the renderer and HUD need about one character. */
export interface ViewPlayer {
  id: number;
  name: string;
  team: number;
  color: number;
  bot: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  hp: number;
  armor: number;
  alive: boolean;
  grounded: boolean;
  jetting: boolean;
  reloading: boolean;
  protect: boolean;
  overdrive: boolean;
  haste: boolean;
  weapon: WeaponId;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
}

/** Local player details that only the HUD shows. */
export interface HudState {
  weapon: WeaponId;
  mag: number;
  reserve: number;
  infinite: boolean;
  primary: WeaponId | null;
  slot: number;
  grenades: number;
  reloadProgress: number | null;
  fuel: number;
  hp: number;
  armor: number;
  overdrive: number;
  haste: number;
  protect: number;
  respawnIn: number;
}

export interface GameView {
  meId: number;
  players: ViewPlayer[];
  heavy: HeavyProjectile[];
  pickups: readonly PickupState[];
  match: MatchState;
  settings: MatchSettings;
  hud: HudState | null;
}

export type InputSampler = () => { b: number; mx: number; aim: number };

export interface Session {
  readonly online: boolean;
  readonly view: GameView;
  /** Advances by one rendered frame. `sample` is called once per fixed tick. */
  update(dt: number, sample: InputSampler): void;
  drainEvents(): GameEvent[];
  results(): ResultRow[];
  /** Position used for aiming: the local player's shoulder. */
  shoulder(): { x: number; y: number } | null;
  dispose(): void;
}

export function viewFromPlayer(p: Player, alpha: number): ViewPlayer {
  return {
    id: p.id, name: p.name, team: p.team, color: p.color, bot: p.bot,
    x: p.px + (p.x - p.px) * alpha,
    y: p.py + (p.y - p.py) * alpha,
    vx: p.vx, vy: p.vy, aim: p.aim, hp: p.hp, armor: p.armor, alive: p.alive, grounded: p.grounded,
    jetting: p.jetting, reloading: p.reloadTimer > 0, protect: p.protect > 0, overdrive: p.overdrive > 0, haste: p.haste > 0,
    weapon: activeWeapon(p).id,
    kills: p.kills, deaths: p.deaths, assists: p.assists, score: p.score,
  };
}

export function hudFromPlayer(p: Player): HudState {
  const w = activeWeapon(p);
  const def = WEAPONS[w.id];
  return {
    weapon: w.id, mag: w.mag, reserve: w.reserve, infinite: def.secondary,
    primary: p.primary?.id ?? null, slot: p.primary ? p.slot : 1, grenades: p.grenades,
    reloadProgress: p.reloadTimer > 0 ? 1 - p.reloadTimer / def.reload : null,
    fuel: p.fuel, hp: p.hp, armor: p.armor, overdrive: p.overdrive, haste: p.haste, protect: p.protect,
    respawnIn: p.alive ? 0 : p.respawnTimer,
  };
}

/**
 * Single-player session. Runs the full World in the browser with no server.
 * With `meName` null it runs a bots-only match, used behind the menus.
 */
export class LocalSession implements Session {
  readonly online = false;
  readonly world: World;
  readonly me: Player | null;
  paused = false;
  private acc = 0;
  private seq = 0;
  private events: GameEvent[] = [];
  view: GameView;

  constructor(settings: MatchSettings, meName: string | null, team: number, botNames: string[]) {
    this.world = new World(settings);
    this.me = meName ? this.world.addPlayer({ name: meName, team }) : null;
    for (let i = 0; i < settings.bots; i++) {
      const t = settings.mode === 'tdm' ? this.world.smallerTeam() : undefined;
      this.world.addPlayer({ name: botNames[i % botNames.length], team: t, bot: settings.difficulty });
    }
    this.view = this.buildView(0);
  }

  update(dt: number, sample: InputSampler): void {
    if (!this.paused) {
      this.acc += Math.min(dt, 0.1);
      while (this.acc >= DT) {
        this.acc -= DT;
        if (this.me) {
          const s = sample();
          const input: InputFrame = { seq: ++this.seq, b: s.b, mx: s.mx, aim: s.aim };
          this.world.setInput(this.me.id, input);
        }
        this.world.step();
        for (const e of this.world.drainEvents()) this.events.push(e);
      }
    }
    this.view = this.buildView(this.paused ? 1 : this.acc / DT);
  }

  private buildView(alpha: number): GameView {
    const w = this.world;
    return {
      meId: this.me?.id ?? 0,
      players: [...w.players.values()].map((p) => viewFromPlayer(p, alpha)),
      heavy: w.heavyProjectiles,
      pickups: w.pickupStates,
      match: w.match,
      settings: w.settings,
      hud: this.me ? hudFromPlayer(this.me) : null,
    };
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  results(): ResultRow[] {
    return this.world.results();
  }

  shoulder() {
    return this.me ? { x: this.me.x, y: this.me.y + SHOULDER_Y } : null;
  }

  dispose(): void {
    this.events = [];
  }
}
