import { Btn, DT, GRENADE_RADIUS, MAX_ARMOR, MAX_HEALTH, PLAYER_H, PLAYER_W, SHOULDER_Y } from './constants';
import { navFor, type NavGrid, type Waypoint } from './nav';
import { lineOfSight, onPlatform, raySolids } from './physics';
import type { World } from './sim';
import type { Difficulty, InputFrame, PickupState, Player } from './types';
import { WEAPONS } from './weapons';

interface Profile {
  /** Seconds before firing at a newly spotted target. */
  reaction: [number, number];
  /** Half-width of the drifting aim error, in world units, at right angles to the line of fire. */
  aimSpread: number;
  /** Bots aim at where the target was this many seconds ago, so strafing makes them miss. */
  trackLag: number;
  /** Aim turn speed in radians per second. */
  turn: number;
  vision: number;
  aggression: number;
  /** Chance per decision to react to an incoming projectile. */
  dodge: number;
  /** How much the bot leads moving targets (0..1). */
  lead: number;
  /** Chance per second to throw a grenade at a suitable target. */
  grenade: number;
  /** Seconds the bot keeps hunting a target it lost sight of. */
  memory: number;
  /** Rifle fire pattern: seconds of fire, then seconds of pause. */
  burst: [number, number];
  /** Share of the time (0..1) the bot keeps moving while it fights. */
  strafe: number;
}

export const PROFILES: Record<Difficulty, Profile> = {
  easy: { reaction: [0.75, 1.1], aimSpread: 2.9, trackLag: 0.4, turn: 4, vision: 20, aggression: 0.3, dodge: 0, lead: 0, grenade: 0.02, memory: 2, burst: [0.3, 0.75], strafe: 0.3 },
  normal: { reaction: [0.5, 0.75], aimSpread: 2.2, trackLag: 0.3, turn: 6, vision: 24, aggression: 0.5, dodge: 0.12, lead: 0.25, grenade: 0.05, memory: 3.5, burst: [0.45, 0.5], strafe: 0.55 },
  hard: { reaction: [0.3, 0.45], aimSpread: 1.6, trackLag: 0.2, turn: 9, vision: 28, aggression: 0.65, dodge: 0.4, lead: 0.6, grenade: 0.09, memory: 5, burst: [0.65, 0.3], strafe: 0.8 },
  elite: { reaction: [0.15, 0.25], aimSpread: 1.1, trackLag: 0.11, turn: 15, vision: 34, aggression: 0.82, dodge: 0.7, lead: 1, grenade: 0.14, memory: 8, burst: [0.9, 0.15], strafe: 1 },
};

export const BOT_NAMES = ['Rivet', 'Sprocket', 'Cinder', 'Gasket', 'Torque', 'Flux', 'Ballast', 'Ratchet', 'Piston', 'Solder', 'Dynamo'];

type State = 'roam' | 'engage' | 'hunt' | 'collect' | 'retreat';

const DECIDE_EVERY = 6; // ticks

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Finite-state bot. It perceives only what it can see (line of sight within its
 * vision range) or hear (nearby gunfire and jetpacks), remembers a lost target for a
 * few seconds, navigates with the shared nav grid, and produces the same InputFrame
 * a human client would send.
 */
export class BotBrain {
  readonly profile: Profile;
  state: State = 'roam';
  private aggression: number;
  private accuracy: number;
  private targetId = 0;
  private lastSeen = { x: 0, y: 0, t: -99 };
  private reactionLeft = 0;
  private aim = 0;
  /** Recent target positions, newest last, for lagged tracking. */
  private history: { x: number; y: number; vx: number; vy: number }[] = [];
  private acquiredAt = 0;
  /** Aim error at right angles to the line of fire. Error along the line would not cause a miss. */
  private offset = 0;
  private offsetTarget = 0;
  private nextOffsetAt = 0;
  private goal: { x: number; y: number } | null = null;
  private path: Waypoint[] = [];
  private repathAt = 0;
  private strafeDir = 1;
  private strafeUntil = 0;
  private dodgeUntil = 0;
  private dodgeDir = 0;
  private stuckCheck = { x: 0, y: 0, t: 0 };
  private stuck = 0;
  private unstickUntil = 0;
  private burstUntil = 0;
  private pauseUntil = 0;
  private wantSlot = 0;
  private wantGrenade = false;
  private wantInteract = false;
  private wantReload = false;
  private restUntil = 0;
  private prevB = 0;
  private seq = 0;
  private nav: NavGrid | null = null;

  constructor(readonly id: number, readonly difficulty: Difficulty, private rand: () => number) {
    this.profile = PROFILES[difficulty];
    this.aggression = Math.min(1, Math.max(0, this.profile.aggression + (rand() - 0.5) * 0.3));
    this.accuracy = 0.8 + rand() * 0.4;
  }

  think(world: World, p: Player): InputFrame {
    this.seq++;
    if (!p.alive) {
      this.state = 'roam';
      this.targetId = 0;
      this.path = [];
      this.goal = null;
      this.prevB = 0;
      return { seq: this.seq, b: 0, mx: 0, aim: this.aim };
    }
    this.nav ??= navFor(world.map);
    const now = world.time;
    if ((world.tick + this.id) % DECIDE_EVERY === 0) this.decide(world, p, now);

    const target = this.targetId ? world.players.get(this.targetId) : undefined;
    let b = 0;
    let mx = 0;

    // Movement.
    const move = this.movement(world, p, target, now);
    mx = move.mx;
    if (move.up) b |= Btn.Up;
    if (move.down) b |= Btn.Down;

    // Aim and fire.
    const visible = !!target && target.alive && this.canSee(world, p, target);
    let desired = this.aim;
    if (target && visible) {
      this.history.push({ x: target.x, y: target.y, vx: target.vx, vy: target.vy });
      if (this.history.length > 40) this.history.shift();
      this.updateOffset(p, target, now);
      desired = this.aimAt(p, target);
    } else if (this.state === 'hunt') {
      desired = Math.atan2(this.lastSeen.y + 1 - (p.y + SHOULDER_Y), this.lastSeen.x - p.x);
    } else if (Math.abs(p.vx) > 0.5) {
      desired = p.vx > 0 ? 0 : Math.PI;
    }
    const maxTurn = this.profile.turn * DT;
    this.aim += Math.max(-maxTurn, Math.min(maxTurn, angleDiff(desired, this.aim)));
    if (this.aim > Math.PI) this.aim -= Math.PI * 2;
    if (this.aim < -Math.PI) this.aim += Math.PI * 2;

    if (target && visible && this.reactionLeft <= 0 && world.match.phase === 'live') {
      const w = WEAPONS[(p.slot === 0 && p.primary ? p.primary : p.secondary).id];
      const dist = Math.hypot(target.x - p.x, target.y - p.y);
      const onTarget = Math.abs(angleDiff(this.aim, desired)) < 0.1 + w.spread;
      const inRange = dist < w.range[2] * 1.15;
      // Lower difficulties fire in shorter bursts with longer pauses.
      if (now > this.burstUntil && now > this.pauseUntil) {
        const [on, off] = this.profile.burst;
        this.burstUntil = now + on * (0.8 + this.rand() * 0.4);
        this.pauseUntil = this.burstUntil + off * (0.8 + this.rand() * 0.4);
      }
      if (onTarget && inRange && now <= this.burstUntil) b |= Btn.Fire;
    }
    this.reactionLeft -= DT;

    if (this.wantSlot !== p.slot && p.primary && p.swapTimer <= 0 && !(this.prevB & Btn.Swap)) b |= Btn.Swap;
    if (this.wantGrenade && !(this.prevB & Btn.Grenade)) {
      b |= Btn.Grenade;
      this.wantGrenade = false;
    }
    if (this.wantInteract && !(this.prevB & Btn.Interact)) {
      b |= Btn.Interact;
      this.wantInteract = false;
    }
    if (this.wantReload && !(this.prevB & Btn.Reload)) {
      b |= Btn.Reload;
      this.wantReload = false;
    }
    this.prevB = b;
    return { seq: this.seq, b, mx, aim: this.aim };
  }

  // ------------------------------------------------------------ perception

  private canSee(world: World, p: Player, t: Player): boolean {
    const dx = t.x - p.x;
    const dy = t.y - p.y;
    if (dx * dx + dy * dy > this.profile.vision * this.profile.vision) return false;
    const ex = p.x;
    const ey = p.y + 1.55;
    return lineOfSight(world.map, ex, ey, t.x, t.y + 1.0) || lineOfSight(world.map, ex, ey, t.x, t.y + 1.6);
  }

  /** Enemies make noise when they fire or use the jetpack. Bots hear that within a radius. */
  private canHear(p: Player, t: Player): boolean {
    const noisy = t.cooldown > 0 || t.jetting;
    return noisy && Math.hypot(t.x - p.x, t.y - p.y) < 18;
  }

  /**
   * Aims like a person: at where the target was a moment ago (reaction lag), plus a
   * drifting error offset, with partial leading on higher difficulties.
   */
  private aimAt(p: Player, t: Player): number {
    const sx = p.x;
    const sy = p.y + SHOULDER_Y;
    const lagTicks = Math.round(this.profile.trackLag / DT);
    const seen = this.history[Math.max(0, this.history.length - 1 - lagTicks)] ?? t;
    const lx = seen.x - sx;
    const ly = seen.y + 1.05 - sy;
    const dist = Math.hypot(lx, ly) || 1;
    let tx = seen.x - (ly / dist) * this.offset;
    let ty = seen.y + 1.05 + (lx / dist) * this.offset;
    const w = WEAPONS[(p.slot === 0 && p.primary ? p.primary : p.secondary).id];
    const travel = dist / w.speed;
    tx += seen.vx * travel * this.profile.lead;
    ty += seen.vy * travel * this.profile.lead * 0.5;
    // Rockets aim at the feet for splash.
    if (w.id === 'rocket' && t.grounded) ty = seen.y + 0.2 + (lx / dist) * this.offset * 0.5;
    return Math.atan2(ty - sy, tx - sx);
  }

  /** Moves the aim error towards a new random point every fraction of a second. */
  private updateOffset(p: Player, t: Player, now: number): void {
    if (now >= this.nextOffsetAt) {
      const speed = Math.hypot(t.vx, t.vy);
      // Aim is worse just after spotting a target, against fast targets and while airborne.
      const settle = 1 + Math.max(0, 1 - (now - this.acquiredAt) / 1.2);
      const r = this.profile.aimSpread * this.accuracy * (1 + speed * 0.04) * (p.grounded ? 1 : 1.35) * settle;
      this.offsetTarget = (this.rand() * 2 - 1) * r;
      this.nextOffsetAt = now + 0.25 + this.rand() * 0.3;
    }
    this.offset += (this.offsetTarget - this.offset) * Math.min(1, DT * 6);
  }

  // ------------------------------------------------------------ decisions

  private decide(world: World, p: Player, now: number): void {
    const prof = this.profile;
    let current = this.targetId ? world.players.get(this.targetId) : undefined;
    if (current && (!current.alive || !world.isEnemy(p, current))) current = undefined;

    // Pick the most convenient visible enemy; prefer to stay on the current one.
    let best: Player | undefined;
    let bestScore = Infinity;
    for (const o of world.players.values()) {
      if (!o.alive || !world.isEnemy(p, o)) continue;
      const seen = this.canSee(world, p, o);
      const heard = !seen && this.canHear(p, o);
      if (!seen && !heard) continue;
      let score = Math.hypot(o.x - p.x, o.y - p.y) + o.hp * 0.04 + (heard ? 12 : 0);
      if (o === current) score -= 6;
      if (o.protect > 0) score += 10;
      if (score < bestScore) {
        bestScore = score;
        best = o;
      }
    }
    if (best) {
      if (best.id !== this.targetId) {
        const [lo, hi] = prof.reaction;
        this.reactionLeft = lo + this.rand() * (hi - lo);
        this.targetId = best.id;
        this.acquiredAt = now;
        this.history = [];
      }
      this.lastSeen = { x: best.x, y: best.y, t: now };
    } else if (now - this.lastSeen.t > prof.memory) {
      this.targetId = 0;
    }

    const tgt = this.targetId ? world.players.get(this.targetId) : undefined;

    // State selection.
    const visibleTarget = !!best && this.canSee(world, p, best);
    const health = this.findPickup(world, p, (it) => it.kind === 'health', 45);
    const lowHp = p.hp < 30 + (1 - this.aggression) * 25;
    if (lowHp && health && !(visibleTarget && this.aggression > 0.75)) {
      this.state = 'retreat';
      this.setGoal(health.x, health.y);
    } else if (visibleTarget) {
      this.state = 'engage';
    } else if (this.targetId && now - this.lastSeen.t <= prof.memory) {
      this.state = 'hunt';
      this.setGoal(this.lastSeen.x, this.lastSeen.y);
    } else {
      const want = this.findPickup(world, p, (it) => this.wants(p, it), 38);
      if (want) {
        this.state = 'collect';
        this.setGoal(want.x, want.y);
      } else {
        if (this.state !== 'roam' || !this.goal || Math.hypot(this.goal.x - p.x, this.goal.y - p.y) < 2) this.pickRoamGoal(world, p);
        this.state = 'roam';
      }
    }

    // Weapon choice.
    const dist = tgt ? Math.hypot(tgt.x - p.x, tgt.y - p.y) : 12;
    this.wantSlot = 0;
    if (!p.primary || p.primary.mag + p.primary.reserve === 0) this.wantSlot = 1;
    else if (p.primary.id === 'rocket' && dist < 4) this.wantSlot = 1;
    else if (p.primary.id === 'shotgun' && dist > 15) this.wantSlot = 1;
    else if (p.primary.id === 'sniper' && dist < 5 && this.difficulty !== 'easy') this.wantSlot = 1;

    // Reload when quiet.
    const w = p.slot === 0 && p.primary ? p.primary : p.secondary;
    const def = WEAPONS[w.id];
    if (!visibleTarget && w.mag < def.mag * 0.5 && p.reloadTimer <= 0 && (def.secondary || w.reserve > 0)) this.wantReload = true;

    // Grenades at targets in mid range, or behind cover.
    if (tgt && p.grenades > 0 && dist > 5 && dist < 17 && this.rand() < prof.grenade * DECIDE_EVERY * DT * 10 * this.aggression) {
      if (visibleTarget || now - this.lastSeen.t < 2) {
        this.wantGrenade = true;
        this.aim = Math.atan2(tgt.y + 1 - (p.y + SHOULDER_Y), tgt.x - p.x) + (tgt.x > p.x ? 1 : -1) * 0.25 * (dist / 16);
      }
    }

    // Swap onto better weapons lying around.
    for (const it of world.pickupStates) {
      if (!it.active || it.kind !== 'weapon' || !it.weapon) continue;
      if (Math.abs(it.x - p.x) > 1 || Math.abs(it.y - p.y) > 1.5) continue;
      const mine = p.primary ? WEAPONS[p.primary.id].rank + (p.primary.mag + p.primary.reserve > 0 ? 0 : -5) : -5;
      if (WEAPONS[it.weapon].rank > mine) this.wantInteract = true;
    }

    // Dodge incoming fire.
    if (now > this.dodgeUntil && this.rand() < prof.dodge) {
      for (const pr of world.threats) {
        if (pr.owner === p.id) continue;
        const owner = world.players.get(pr.owner);
        if (owner && !world.isEnemy(p, owner)) continue;
        const rx = p.x - pr.x;
        const ry = p.y + 0.9 - pr.y;
        const d = Math.hypot(rx, ry);
        if (pr.kind === 'grenade') {
          if (d < GRENADE_RADIUS + 1.5 && pr.life < 1.4) {
            this.dodgeUntil = now + 0.6;
            this.dodgeDir = rx >= 0 ? 1 : -1;
          }
          continue;
        }
        const sp = Math.hypot(pr.vx, pr.vy);
        if (d > 18 || sp < 1) continue;
        const closing = (rx * pr.vx + ry * pr.vy) / (d * sp);
        if (closing > 0.9) {
          this.dodgeUntil = now + 0.25 + this.rand() * 0.2;
          this.dodgeDir = this.rand() < 0.5 ? -1 : 1;
          break;
        }
      }
    }

    // Stuck detection.
    if (now - this.stuckCheck.t > 0.6) {
      const moved = Math.hypot(p.x - this.stuckCheck.x, p.y - this.stuckCheck.y);
      const trying = this.state !== 'engage' && this.path.length > 0;
      if (trying && moved < 0.35) {
        this.stuck++;
        this.unstickUntil = now + 0.45;
        this.strafeDir = this.strafeDir > 0 ? -1 : 1;
        this.repathAt = 0;
        if (this.stuck >= 3) {
          this.pickRoamGoal(world, p);
          this.stuck = 0;
        }
      } else if (moved > 1) {
        this.stuck = 0;
      }
      this.stuckCheck = { x: p.x, y: p.y, t: now };
    }
  }

  private wants(p: Player, it: PickupState): boolean {
    switch (it.kind) {
      case 'health': return p.hp < MAX_HEALTH * 0.75;
      case 'armor': return p.armor < MAX_ARMOR * 0.5;
      case 'ammo': return !!p.primary && p.primary.reserve < WEAPONS[p.primary.id].mag;
      case 'grenades': return p.grenades < 2;
      case 'overdrive':
      case 'haste': return true;
      case 'weapon': {
        if (!it.weapon) return false;
        const mine = p.primary ? WEAPONS[p.primary.id].rank : -5;
        return WEAPONS[it.weapon].rank > mine + (this.difficulty === 'easy' ? 1 : 0);
      }
    }
  }

  private findPickup(world: World, p: Player, ok: (it: PickupState) => boolean, range: number): PickupState | undefined {
    let best: PickupState | undefined;
    let bestD = range;
    for (const it of world.pickupStates) {
      if (!it.active || !ok(it)) continue;
      const d = Math.hypot(it.x - p.x, it.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    return best;
  }

  private pickRoamGoal(world: World, p: Player): void {
    // Wander between points of interest: spawns and item spots, biased away from here.
    const spots = [...world.map.spawns, ...world.map.items];
    for (let i = 0; i < 6; i++) {
      const s = spots[Math.floor(this.rand() * spots.length)];
      if (Math.hypot(s.x - p.x, s.y - p.y) > 10 || i === 5) {
        this.setGoal(s.x, s.y);
        return;
      }
    }
  }

  private setGoal(x: number, y: number): void {
    if (!this.goal || Math.hypot(this.goal.x - x, this.goal.y - y) > 2.5) {
      this.goal = { x, y };
      this.repathAt = 0;
    }
  }

  // ------------------------------------------------------------ movement

  private movement(world: World, p: Player, target: Player | undefined, now: number): { mx: number; up: boolean; down: boolean } {
    let mx = 0;
    let up = false;
    let down = false;

    if (this.state === 'engage' && target) {
      const w = WEAPONS[(p.slot === 0 && p.primary ? p.primary : p.secondary).id];
      const dx = target.x - p.x;
      const dist = Math.hypot(dx, target.y - p.y);
      const [minR, ideal] = w.range;
      const push = ideal * (1.2 - this.aggression * 0.5);
      if (now > this.strafeUntil) {
        // Lower difficulties often stand still to shoot.
        this.strafeDir = this.rand() >= this.profile.strafe ? 0 : this.rand() < 0.5 ? -1 : 1;
        this.strafeUntil = now + 0.5 + this.rand() * 1.1;
      }
      if (dist > push + 3) {
        // Close in along the nav path.
        this.setGoal(target.x, target.y);
        const f = this.followPath(world, p, now);
        mx = f.mx;
        up = f.up;
        down = f.down;
      } else if (dist < minR) {
        mx = dx > 0 ? -1 : 1;
      } else {
        mx = this.strafeDir;
      }
      // Hop and jet to stay hard to hit, more on higher difficulty.
      if (p.grounded && this.rand() < this.aggression * this.profile.strafe * 0.02) up = true;
      if (target.y > p.y + 3 && p.fuel > 30) up = true;
    } else if (this.goal) {
      const f = this.followPath(world, p, now);
      mx = f.mx;
      up = f.up;
      down = f.down;
    }

    if (now < this.dodgeUntil) {
      mx = this.dodgeDir || mx;
      if (p.fuel > 20) up = true;
    }
    if (now < this.unstickUntil) {
      up = p.fuel > 10;
      mx = this.strafeDir;
    }

    // Do not step off into a bottomless drop or hazard while strafing.
    if (mx !== 0 && p.grounded && !up && this.nav) {
      const ahead = p.x + mx * 1.2;
      if (!this.nav.isSupported(ahead, p.y) && !this.nav.isSupported(ahead, p.y - 1)) {
        if (this.state === 'engage') mx = 0;
      }
    }
    for (const h of world.map.hazards) {
      if (p.x + PLAYER_W > h.x && p.x - PLAYER_W < h.x + h.w && p.y < h.y + h.h + 1 && p.y > h.y - 1) {
        up = p.fuel > 0;
      }
    }
    // Save the last of the fuel for emergencies; rest on the ground until it refills.
    if (p.grounded && p.fuel < 18) this.restUntil = now + 0.9;
    if (now < this.restUntil && p.grounded && !(now < this.dodgeUntil)) up = false;
    // Falling towards the kill line: always burn fuel.
    if (!p.grounded && p.vy < -4 && p.y < world.map.killY + 10 && p.fuel > 0) up = true;
    return { mx, up, down };
  }

  private followPath(world: World, p: Player, now: number): { mx: number; up: boolean; down: boolean } {
    if (!this.goal || !this.nav) return { mx: 0, up: false, down: false };
    if (now >= this.repathAt || this.path.length === 0) {
      this.path = this.nav.findPath(p.x, p.y, this.goal.x, this.goal.y) ?? [];
      this.repathAt = now + 0.8 + this.rand() * 0.4;
      if (this.path.length === 0) {
        this.repathAt = now + 0.4;
      }
    }
    while (this.path.length > 1) {
      const wp = this.path[0];
      if (Math.abs(wp.x - p.x) < 0.6 && Math.abs(wp.y - p.y) < 1.1) this.path.shift();
      else break;
    }
    const wp = this.path[Math.min(1, this.path.length - 1)] ?? this.path[0];
    if (!wp) return { mx: 0, up: false, down: false };
    const dx = wp.x - p.x;
    const dy = wp.y - p.y;
    const mx = Math.abs(dx) > 0.3 ? Math.sign(dx) : 0;
    let up = dy > 0.45;
    // Keep altitude over gaps.
    if (!wp.supported && !p.grounded && p.vy < 0 && dy > -1.5) up = true;
    // Blocked by a step or wall: hop.
    if (mx !== 0 && p.grounded && Math.abs(p.vx) < 0.4 && this.blockedAhead(world, p, mx)) up = true;
    const down = dy < -0.8 && p.grounded && onPlatform(p, world.map, PLAYER_W);
    if (this.path.length <= 1 && Math.hypot(this.goal.x - p.x, this.goal.y - p.y) < 1) this.path = [];
    return { mx, up, down };
  }

  private blockedAhead(world: World, p: Player, mx: number): boolean {
    const x = p.x + mx * (PLAYER_W / 2 + 0.2);
    // Platforms do not block sideways movement, so only solids count here.
    return raySolids(world.map, p.x, p.y + 0.3, x, p.y + 0.3) < 1 || raySolids(world.map, p.x, p.y + PLAYER_H - 0.2, x, p.y + PLAYER_H - 0.2) < 1;
  }
}
