import { BotBrain } from './bots';
import {
  ARMOR_ABSORB, ASSIST_MIN_DAMAGE, ASSIST_WINDOW, Btn, COUNTDOWN_TIME, CREDIT_WINDOW, DROP_LIFETIME, DT,
  GRAVITY, GRENADE_DAMAGE, GRENADE_FUSE, GRENADE_RADIUS, GRENADE_SPEED, HEAD_Y, MAX_ARMOR, MAX_DROPPED, MAX_GRENADES,
  MAX_HEALTH, MAX_PLAYERS, MAX_PROJECTILES, OVERDRIVE_MULT, PLAYER_H, PLAYER_W, POWERUP_TIME, RESPAWN_TIME,
  SELF_DAMAGE_MULT, SHOULDER_Y, SPAWN_PROTECT,
} from './constants';
import { getMap, type ItemKind, type MapDef } from './maps';
import { boxOverlapsRect, raySolids, segmentRect } from './physics';
import { newPlayer, spawnPlayer, stepPlayer, type PlayerCtx } from './player';
import { mulberry32 } from './rng';
import type {
  Difficulty, GameEvent, HeavyProjectile, InputFrame, KillCause, MatchSettings, MatchState, PickupState, Player, ResultRow,
} from './types';
import { IDLE_INPUT } from './types';
import { WEAPONS, freshWeapon, type WeaponDef, type WeaponId, type WeaponState } from './weapons';

interface Projectile {
  id: number;
  kind: 'bullet' | 'rocket' | 'grenade';
  owner: number;
  team: number;
  weapon: WeaponId | 'grenade';
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  damage: number;
  headMult: number;
  radius: number;
  knock: number;
}

interface Pickup extends PickupState {
  respawn: number;
  timer: number;
  ammo?: WeaponState;
  vy: number;
  resting: boolean;
}

const RESPAWN_SECONDS: Record<ItemKind, number> = {
  health: 15, armor: 25, ammo: 15, grenades: 18, overdrive: 40, haste: 35, weapon: 15,
};

export interface AddPlayerOptions {
  name: string;
  team?: number;
  bot?: Difficulty;
}

/**
 * The authoritative match simulation. The browser runs it for single player; the
 * Durable Object runs the same code for online rooms. It advances in fixed ticks and
 * records presentation events for the renderer and the network layer.
 */
export class World {
  readonly map: MapDef;
  readonly settings: MatchSettings;
  readonly players = new Map<number, Player>();
  readonly bots = new Map<number, BotBrain>();
  readonly events: GameEvent[] = [];
  readonly match: MatchState;
  tick = 0;
  time = 0;
  rand: () => number;
  private inputs = new Map<number, InputFrame>();
  private projectiles: Projectile[] = [];
  private pickups: Pickup[] = [];
  private nextPlayerId = 1;
  private nextEntityId = 1;
  private ctx: PlayerCtx;

  constructor(settings: MatchSettings, seed = Date.now()) {
    this.settings = { ...settings };
    this.map = getMap(settings.map);
    this.rand = mulberry32(seed);
    this.match = {
      phase: 'countdown',
      mode: settings.mode,
      timeLeft: COUNTDOWN_TIME,
      killLimit: settings.killLimit,
      teamScores: [0, 0],
      winner: -1,
    };
    for (const item of this.map.items) {
      this.pickups.push({
        id: this.nextEntityId++, kind: item.kind, weapon: item.weapon, x: item.x, y: item.y, active: true, dropped: false,
        respawn: RESPAWN_SECONDS[item.kind], timer: 0, vy: 0, resting: true,
      });
    }
    this.ctx = {
      map: this.map,
      frozen: true,
      rand: () => this.rand(),
      fire: (p, def, aim) => this.fire(p, def, aim),
      grenade: (p) => this.throwGrenade(p),
      emit: (e) => this.events.push(e),
    };
  }

  // ---------------------------------------------------------------- roster

  addPlayer(opts: AddPlayerOptions): Player | null {
    if (this.players.size >= MAX_PLAYERS) return null;
    const id = this.nextPlayerId++;
    const team = this.settings.mode === 'tdm' ? (opts.team === 0 || opts.team === 1 ? opts.team : this.smallerTeam()) : -1;
    const used = new Set([...this.players.values()].map((p) => p.color));
    let color = 0;
    while (used.has(color)) color++;
    const p = newPlayer(id, opts.name.slice(0, 16), team, color, !!opts.bot);
    this.players.set(id, p);
    if (opts.bot) this.bots.set(id, new BotBrain(id, opts.bot, this.rand));
    if (this.match.phase !== 'ended') this.respawn(p);
    return p;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
    this.bots.delete(id);
    this.inputs.delete(id);
  }

  smallerTeam(): number {
    let a = 0;
    let b = 0;
    for (const p of this.players.values()) {
      if (p.team === 0) a++;
      else if (p.team === 1) b++;
    }
    return a <= b ? 0 : 1;
  }

  setInput(id: number, input: InputFrame): void {
    this.inputs.set(id, input);
  }

  // ---------------------------------------------------------------- queries

  get heavyProjectiles(): HeavyProjectile[] {
    const out: HeavyProjectile[] = [];
    for (const pr of this.projectiles) {
      if (pr.kind !== 'bullet') out.push({ id: pr.id, kind: pr.kind, x: pr.x, y: pr.y, vx: pr.vx, vy: pr.vy, life: pr.life });
    }
    return out;
  }

  /** Incoming threats for bot dodging: positions and velocities of live projectiles. */
  get threats(): readonly Projectile[] {
    return this.projectiles;
  }

  get pickupStates(): readonly PickupState[] {
    return this.pickups;
  }

  isEnemy(a: Player, b: Player): boolean {
    if (a.id === b.id) return false;
    return this.settings.mode !== 'tdm' || a.team !== b.team;
  }

  results(): ResultRow[] {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, team: p.team, color: p.color, bot: p.bot, kills: p.kills, deaths: p.deaths, assists: p.assists, score: p.score }))
      .sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);
  }

  // ---------------------------------------------------------------- step

  step(): void {
    this.tick++;
    this.time += DT;
    const m = this.match;

    if (m.phase === 'ended') return;
    if (m.phase === 'countdown') {
      m.timeLeft -= DT;
      if (m.timeLeft <= 0) {
        m.phase = 'live';
        m.timeLeft = this.settings.timeLimit;
        // Spawn shields start when the fighting does, not during the countdown.
        for (const p of this.players.values()) if (p.alive) p.protect = SPAWN_PROTECT;
        this.events.push({ k: 'phase', phase: 'live' });
      }
    } else {
      m.timeLeft -= DT;
    }
    this.ctx.frozen = m.phase !== 'live';

    for (const [id, brain] of this.bots) {
      const p = this.players.get(id);
      if (p) this.inputs.set(id, brain.think(this, p));
    }

    for (const p of this.players.values()) {
      const input = this.inputs.get(p.id) ?? IDLE_INPUT;
      const pressed = stepPlayer(p, input, this.ctx);
      if (!p.alive) {
        if (m.phase === 'live') {
          p.respawnTimer -= DT;
          if (p.respawnTimer <= 0) this.respawn(p);
        }
        continue;
      }
      if (!this.ctx.frozen) this.touchPickups(p, (pressed & Btn.Interact) !== 0);
      this.environment(p);
    }

    this.stepProjectiles();
    this.stepPickups();

    if (m.phase === 'live') this.checkEnd();
  }

  private environment(p: Player): void {
    if (p.y < this.map.killY) {
      this.kill(p, 0, 'fall', false);
      return;
    }
    for (const h of this.map.hazards) {
      if (boxOverlapsRect(p.x - PLAYER_W / 2, p.y, PLAYER_W, PLAYER_H, h)) {
        // Hazards ignore spawn protection so nobody can camp in them.
        const prot = p.protect;
        p.protect = 0;
        this.damage(p, h.dps * DT, 0, 'hazard', false, p.x, p.y + 0.3, false);
        p.protect = prot;
        if (!p.alive) return;
      }
    }
  }

  private checkEnd(): void {
    const m = this.match;
    let done = m.timeLeft <= 0;
    if (this.settings.mode === 'tdm') {
      if (m.teamScores[0] >= m.killLimit || m.teamScores[1] >= m.killLimit) done = true;
    } else {
      for (const p of this.players.values()) if (p.score >= m.killLimit) done = true;
    }
    if (!done) return;
    m.phase = 'ended';
    m.timeLeft = Math.max(0, m.timeLeft);
    if (this.settings.mode === 'tdm') {
      const [a, b] = m.teamScores;
      m.winner = a === b ? -1 : a > b ? 0 : 1;
    } else {
      const rows = this.results();
      m.winner = rows.length && (rows.length < 2 || rows[0].score > rows[1].score) ? rows[0].id : -1;
    }
    this.events.push({ k: 'phase', phase: 'ended' });
  }

  // ---------------------------------------------------------------- spawning

  private respawn(p: Player): void {
    const spawns = this.map.spawns;
    const tdm = this.settings.mode === 'tdm';
    const pool = tdm ? spawns.filter((s) => s.team === undefined || s.team === p.team) : spawns;
    let best = pool[0];
    let bestScore = -Infinity;
    for (const s of pool) {
      let nearest = 60;
      for (const o of this.players.values()) {
        if (!o.alive || o.id === p.id) continue;
        const d = Math.hypot(o.x - s.x, o.y - s.y);
        if (this.isEnemy(p, o)) nearest = Math.min(nearest, d);
        else if (d < 1.5) nearest = Math.min(nearest, 2);
      }
      // Team spawns favour the team's own side.
      const sideBonus = tdm && s.team === p.team ? 6 : 0;
      const score = nearest + sideBonus + this.rand() * 8;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    spawnPlayer(p, best.x + (this.rand() - 0.5) * 0.6, best.y + 0.01);
    this.events.push({ k: 'spawn', p: p.id, x: p.x, y: p.y });
  }

  // ---------------------------------------------------------------- combat

  private fire(p: Player, def: WeaponDef, aim: number): void {
    const ox = p.x;
    const oy = p.y + SHOULDER_Y;
    const mult = p.overdrive > 0 ? OVERDRIVE_MULT : 1;
    this.events.push({ k: 'shot', p: p.id, w: def.id, x: ox + Math.cos(aim) * 0.95, y: oy + Math.sin(aim) * 0.95, a: aim });
    for (let i = 0; i < def.pellets; i++) {
      if (this.projectiles.length >= MAX_PROJECTILES) break;
      const a = aim + (this.rand() * 2 - 1) * def.spread;
      const speed = def.speed * (def.pellets > 1 ? 0.85 + this.rand() * 0.3 : 1);
      const pr: Projectile = {
        id: this.nextEntityId++, kind: def.kind, owner: p.id, team: p.team, weapon: def.id,
        x: ox, y: oy, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: def.life,
        damage: def.damage * mult, headMult: def.headMult, radius: def.radius, knock: def.knock,
      };
      this.projectiles.push(pr);
      if (def.kind === 'bullet') {
        this.events.push({ k: 'bullet', id: pr.id, p: p.id, w: def.id, x: ox, y: oy, vx: pr.vx, vy: pr.vy, life: pr.life });
      }
    }
  }

  private throwGrenade(p: Player): void {
    if (this.projectiles.length >= MAX_PROJECTILES) return;
    const a = p.aim;
    this.projectiles.push({
      id: this.nextEntityId++, kind: 'grenade', owner: p.id, team: p.team, weapon: 'grenade',
      x: p.x, y: p.y + SHOULDER_Y,
      vx: Math.cos(a) * GRENADE_SPEED + p.vx * 0.35, vy: Math.sin(a) * GRENADE_SPEED + p.vy * 0.35 + 2,
      life: GRENADE_FUSE, damage: GRENADE_DAMAGE * (p.overdrive > 0 ? OVERDRIVE_MULT : 1), headMult: 1,
      radius: GRENADE_RADIUS, knock: 15,
    });
  }

  private stepProjectiles(): void {
    const list = this.projectiles;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const pr = list[i];
      const keep = pr.kind === 'grenade' ? this.stepGrenade(pr) : this.stepBullet(pr);
      if (keep) list[w++] = pr;
    }
    list.length = w;
  }

  /** Moves a bullet or rocket one tick. Returns false once it is spent. */
  private stepBullet(pr: Projectile): boolean {
    const dx = pr.vx * DT;
    const dy = pr.vy * DT;
    let t = raySolids(this.map, pr.x, pr.y, pr.x + dx, pr.y + dy);
    const wallT = t;
    let target: Player | null = null;
    for (const p of this.players.values()) {
      if (!p.alive || p.id === pr.owner) continue;
      if (this.settings.mode === 'tdm' && p.team === pr.team) continue;
      const pt = segmentRect(pr.x, pr.y, dx, dy, p.x - PLAYER_W / 2, p.y, PLAYER_W, PLAYER_H);
      if (pt >= 0 && pt < t) {
        t = pt;
        target = p;
      }
    }
    const hx = pr.x + dx * t;
    const hy = pr.y + dy * t;
    pr.life -= DT;

    if (pr.kind === 'rocket') {
      if (target || wallT < 1 || pr.life <= 0) {
        const back = target ? 0 : 0.25;
        const len = Math.hypot(dx, dy) || 1;
        this.explode(hx - (dx / len) * back, hy - (dy / len) * back, pr.radius, pr.damage, pr.owner, 'rocket', pr.knock);
        return false;
      }
      pr.x += dx;
      pr.y += dy;
      return true;
    }

    if (target) {
      const head = hy - target.y > HEAD_Y;
      const dmg = pr.damage * (head ? pr.headMult : 1);
      const len = Math.hypot(pr.vx, pr.vy) || 1;
      target.vx += (pr.vx / len) * pr.knock;
      this.events.push({ k: 'impact', id: pr.id, x: hx, y: hy, flesh: true });
      this.damage(target, dmg, pr.owner, pr.weapon as WeaponId, head, hx, hy);
      return false;
    }
    if (wallT < 1) {
      this.events.push({ k: 'impact', id: pr.id, x: hx, y: hy, flesh: false });
      return false;
    }
    pr.x += dx;
    pr.y += dy;
    return pr.life > 0;
  }

  private stepGrenade(pr: Projectile): boolean {
    pr.life -= DT;
    if (pr.life <= 0) {
      this.explode(pr.x, pr.y, pr.radius, pr.damage, pr.owner, 'grenade', pr.knock);
      return false;
    }
    pr.vy -= GRAVITY * DT;
    const r = 0.16;
    let nx = pr.x + pr.vx * DT;
    for (const s of this.map.solids) {
      if (boxOverlapsRect(nx - r, pr.y - r, r * 2, r * 2, s)) {
        nx = pr.x;
        pr.vx *= -0.45;
        break;
      }
    }
    pr.x = nx;
    const prevBottom = pr.y - r;
    let ny = pr.y + pr.vy * DT;
    let bounced = false;
    for (const s of this.map.solids) {
      if (boxOverlapsRect(pr.x - r, ny - r, r * 2, r * 2, s)) {
        ny = pr.y;
        bounced = true;
        break;
      }
    }
    if (!bounced && pr.vy < 0) {
      for (const s of this.map.platforms) {
        const top = s.y + s.h;
        if (prevBottom >= top && ny - r < top && pr.x > s.x && pr.x < s.x + s.w) {
          ny = top + r;
          bounced = true;
          break;
        }
      }
    }
    if (bounced) {
      if (pr.vy < 0) pr.vx *= 0.75;
      pr.vy *= -0.42;
      if (Math.abs(pr.vy) < 1.2) pr.vy = 0;
    }
    pr.y = ny;
    return pr.y > this.map.killY - 4;
  }

  private explode(x: number, y: number, radius: number, damage: number, owner: number, cause: KillCause, knock: number): void {
    this.events.push({ k: 'boom', x, y, r: radius });
    const reach = radius + 0.4;
    for (const p of [...this.players.values()]) {
      if (!p.alive) continue;
      const cx = p.x;
      const cy = p.y + PLAYER_H / 2;
      const d = Math.hypot(cx - x, cy - y);
      if (d > reach) continue;
      if (raySolids(this.map, x, y, cx, cy) < 1 && raySolids(this.map, x, y, cx, p.y + PLAYER_H - 0.1) < 1) continue;
      const f = 1 - d / reach;
      const nx = d > 0.01 ? (cx - x) / d : 0;
      const ny = d > 0.01 ? (cy - y) / d : 1;
      p.vx += nx * knock * (0.4 + f);
      p.vy += Math.max(ny, 0.25) * knock * (0.4 + f);
      p.grounded = false;
      let dmg = damage * (0.25 + 0.75 * f);
      if (p.id === owner) dmg *= SELF_DAMAGE_MULT;
      else if (this.settings.mode === 'tdm' && this.players.get(owner)?.team === p.team) continue;
      this.damage(p, dmg, owner, cause, false, cx, cy, true);
    }
  }

  /**
   * Applies damage after spawn protection, power-ups, teams and armour.
   * `attacker` is 0 for the environment.
   */
  damage(target: Player, amount: number, attacker: number, cause: KillCause, head: boolean, x: number, y: number, emit = true): void {
    if (!target.alive || target.protect > 0 || amount <= 0) return;
    const src = attacker ? this.players.get(attacker) : undefined;
    if (src && src.id !== target.id && !this.isEnemy(src, target)) return;
    const absorbed = Math.min(target.armor, amount * ARMOR_ABSORB);
    target.armor -= absorbed;
    target.hp -= amount - absorbed;
    target.hurtTime = 0;
    if (attacker && attacker !== target.id) {
      target.lastHitBy = attacker;
      target.lastHitTime = this.time;
      const entry = target.damageLog.find((e) => e.by === attacker);
      if (entry) {
        entry.dmg += amount;
        entry.t = this.time;
      } else {
        target.damageLog.push({ by: attacker, dmg: amount, t: this.time });
      }
    }
    if (emit && cause !== 'hazard') this.events.push({ k: 'hit', p: target.id, by: attacker, d: Math.round(amount), x, y, head });
    if (target.hp <= 0) this.kill(target, attacker, cause, head);
  }

  private kill(victim: Player, attacker: number, cause: KillCause, head: boolean): void {
    if (!victim.alive) return;
    victim.alive = false;
    victim.hp = 0;
    victim.deaths++;
    victim.streak = 0;
    victim.respawnTimer = RESPAWN_TIME;
    victim.jetting = false;

    let killerId = attacker;
    if ((!killerId || killerId === victim.id) && victim.lastHitBy && victim.lastHitBy !== victim.id && this.time - victim.lastHitTime < CREDIT_WINDOW) {
      killerId = victim.lastHitBy;
    }
    const killer = killerId ? this.players.get(killerId) : undefined;
    let streak = 0;
    if (killer && killer.id !== victim.id && this.isEnemy(killer, victim)) {
      killer.kills++;
      killer.score++;
      killer.streak++;
      streak = killer.streak;
      if (this.settings.mode === 'tdm' && (killer.team === 0 || killer.team === 1)) this.match.teamScores[killer.team]++;
    } else {
      victim.score--;
      killerId = 0;
    }

    let assist = 0;
    let best = 0;
    for (const e of victim.damageLog) {
      if (e.by === killerId || e.by === victim.id || this.time - e.t > ASSIST_WINDOW || e.dmg < ASSIST_MIN_DAMAGE) continue;
      const a = this.players.get(e.by);
      if (!a || !this.isEnemy(a, victim)) continue;
      a.assists++;
      if (e.dmg > best) {
        best = e.dmg;
        assist = a.id;
      }
    }
    victim.damageLog = [];
    this.events.push({ k: 'kill', p: victim.id, by: killerId, w: cause, as: assist, head, streak });

    if (victim.primary && victim.primary.mag + victim.primary.reserve > 0) {
      this.dropWeapon(victim.primary, victim.x, victim.y + 0.8);
    }
    victim.primary = null;
  }

  // ---------------------------------------------------------------- pickups

  private dropWeapon(w: WeaponState, x: number, y: number): void {
    const dropped = this.pickups.filter((p) => p.dropped);
    if (dropped.length >= MAX_DROPPED) {
      const oldest = dropped[0];
      this.pickups.splice(this.pickups.indexOf(oldest), 1);
    }
    this.pickups.push({
      id: this.nextEntityId++, kind: 'weapon', weapon: w.id, ammo: { ...w }, x, y, active: true, dropped: true,
      respawn: 0, timer: DROP_LIFETIME, vy: 2, resting: false,
    });
  }

  private touchPickups(p: Player, interact: boolean): void {
    for (const it of this.pickups) {
      if (!it.active) continue;
      if (Math.abs(p.x - it.x) > 1.0 || Math.abs(it.y + 0.5 - (p.y + 0.9)) > 1.4) continue;
      if (it.kind === 'weapon') {
        this.touchWeapon(p, it, interact);
        // Only one weapon swap per press.
        if (interact) interact = false;
        continue;
      }
      if (this.collect(p, it.kind)) this.consume(it, p);
    }
  }

  private touchWeapon(p: Player, it: Pickup, interact: boolean): void {
    const id = it.weapon!;
    const def = WEAPONS[id];
    const ammo = it.ammo ?? freshWeapon(id);
    if (p.primary && p.primary.id === id) {
      if (p.primary.reserve >= def.maxReserve) return;
      p.primary.reserve = Math.min(def.maxReserve, p.primary.reserve + ammo.mag + ammo.reserve);
      this.consume(it, p);
      return;
    }
    if (p.primary && !interact) return;
    if (p.primary) {
      if (it.dropped) {
        // Swap in place: the pickup becomes the player's old weapon.
        const old = p.primary;
        p.primary = { ...ammo };
        it.weapon = old.id;
        it.ammo = { ...old };
        it.timer = DROP_LIFETIME;
        this.events.push({ k: 'pickup', p: p.id, kind: 'weapon', w: id });
      } else {
        this.dropWeapon(p.primary, p.x, p.y + 0.6);
        p.primary = { ...ammo };
        this.consume(it, p);
      }
    } else {
      p.primary = { ...ammo };
      this.consume(it, p);
    }
    p.slot = 0;
    p.reloadTimer = 0;
    p.swapTimer = 0.25;
  }

  /** Applies a non-weapon pickup. Returns false when the player does not need it. */
  private collect(p: Player, kind: ItemKind): boolean {
    switch (kind) {
      case 'health':
        if (p.hp >= MAX_HEALTH) return false;
        p.hp = Math.min(MAX_HEALTH, p.hp + 50);
        return true;
      case 'armor':
        if (p.armor >= MAX_ARMOR) return false;
        p.armor = Math.min(MAX_ARMOR, p.armor + 50);
        return true;
      case 'ammo': {
        const prim = p.primary;
        const def = prim ? WEAPONS[prim.id] : null;
        const needAmmo = !!(prim && def && prim.reserve < def.maxReserve);
        if (!needAmmo && p.grenades >= MAX_GRENADES) return false;
        if (prim && def) prim.reserve = Math.min(def.maxReserve, prim.reserve + def.mag * 2);
        p.grenades = Math.min(MAX_GRENADES, p.grenades + 1);
        return true;
      }
      case 'grenades':
        if (p.grenades >= MAX_GRENADES) return false;
        p.grenades = Math.min(MAX_GRENADES, p.grenades + 2);
        return true;
      case 'overdrive':
        p.overdrive = POWERUP_TIME;
        return true;
      case 'haste':
        p.haste = POWERUP_TIME;
        p.fuel = 100;
        return true;
      default:
        return false;
    }
  }

  private consume(it: Pickup, p: Player): void {
    this.events.push({ k: 'pickup', p: p.id, kind: it.kind, w: it.weapon });
    if (it.dropped) {
      this.pickups.splice(this.pickups.indexOf(it), 1);
      return;
    }
    it.active = false;
    it.timer = it.respawn;
  }

  private stepPickups(): void {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const it = this.pickups[i];
      if (it.dropped) {
        it.timer -= DT;
        if (!it.resting) this.fallPickup(it);
        if (it.timer <= 0 || it.y < this.map.killY) this.pickups.splice(i, 1);
      } else if (!it.active) {
        it.timer -= DT;
        if (it.timer <= 0) it.active = true;
      }
    }
  }

  private fallPickup(it: Pickup): void {
    it.vy = Math.max(-20, it.vy - GRAVITY * DT);
    const prev = it.y;
    let ny = it.y + it.vy * DT;
    for (const r of [...this.map.solids, ...this.map.platforms]) {
      const top = r.y + r.h;
      if (it.x >= r.x && it.x <= r.x + r.w && prev >= top - 0.01 && ny <= top) {
        ny = top;
        it.resting = true;
        it.vy = 0;
        break;
      }
    }
    it.y = ny;
  }

  /** Clears transient per-tick state. Call after the events have been consumed. */
  drainEvents(): GameEvent[] {
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }
}
