import { DT, SHOULDER_Y, TICK_RATE } from '../shared/constants';
import { getMap } from '../shared/maps';
import { applyPredicted, newPlayer, stepPlayer, type PlayerCtx } from '../shared/player';
import {
  FLAG, WEAPON_INDEX, decodePickup,
  type ClientMsg, type PlayerSnap, type RosterEntry, type ServerMsg,
} from '../shared/protocol';
import type {
  GameEvent, HeavyProjectile, InputFrame, MatchSettings, MatchState, PickupState, Player, ResultRow,
} from '../shared/types';
import { hudFromPlayer, viewFromPlayer, type GameView, type InputSampler, type Session, type ViewPlayer } from './session';

type RoomMsg = Extract<ServerMsg, { t: 'room' }>;
type MatchMsg = Extract<ServerMsg, { t: 'match' }>;
type SnapMsg = Extract<ServerMsg, { t: 'snap' }>;
type EndMsg = Extract<ServerMsg, { t: 'end' }>;

export type NetStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface NetHandlers {
  room(msg: RoomMsg): void;
  match(msg: MatchMsg): void;
  end(msg: EndMsg): void;
  notice(text: string): void;
  status(s: NetStatus, detail?: string): void;
}

const RETRY_DELAYS = [500, 1000, 2000, 3000, 4000, 5000];

/**
 * WebSocket connection to one room. Reconnects automatically after an unexpected
 * drop; the server keeps the player's slot for a grace period.
 */
export class NetClient {
  room: RoomMsg | null = null;
  rtt: number | null = null;
  session: NetSession | null = null;
  private ws: WebSocket | null = null;
  private left = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly code: string, private name: string, private cid: string, private handlers: NetHandlers) {}

  /** Opens the socket. Resolves once the room state arrives; rejects with a readable message. */
  connect(create: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const q = new URLSearchParams({ name: this.name, cid: this.cid, create: create ? '1' : '0' });
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${proto}://${location.host}/ws/${this.code}?${q}`);
      } catch {
        reject(new Error('Could not open a connection to the game server.'));
        return;
      }
      this.ws = ws;
      this.handlers.status(this.attempt ? 'reconnecting' : 'connecting');
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new Error('The game server did not answer. Check your connection and try again.'));
      }, 8000);

      ws.onmessage = (e) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(e.data as string);
        } catch {
          return;
        }
        if (msg.t === 'error') {
          this.left = true;
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(msg.msg));
          } else {
            this.handlers.status('closed', msg.msg);
          }
          return;
        }
        if (msg.t === 'room' && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.attempt = 0;
          this.handlers.status('open');
          this.startPing();
          resolve();
        }
        this.handle(msg);
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        this.stopPing();
        if (ws !== this.ws) return;
        if (!settled) {
          settled = true;
          reject(new Error(this.attempt ? 'Lost the room. It may have closed.' : 'Could not reach the game server. Is it running?'));
          return;
        }
        if (!this.left) this.retry();
      };
    });
  }

  private retry(): void {
    if (this.attempt >= RETRY_DELAYS.length) {
      this.handlers.status('closed', 'Connection lost. The room could not be reached again.');
      return;
    }
    const delay = RETRY_DELAYS[this.attempt++];
    this.handlers.status('reconnecting', `Connection lost. Reconnecting (attempt ${this.attempt})…`);
    this.retryTimer = setTimeout(() => {
      this.connect(false).catch((err: Error) => {
        if (this.left) this.handlers.status('closed', err.message);
        else this.retry();
      });
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    const ping = () => this.send({ t: 'ping', c: performance.now() });
    ping();
    this.pingTimer = setInterval(ping, 2000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'room':
        this.room = msg;
        this.handlers.room(msg);
        break;
      case 'match':
        this.session?.dispose();
        this.session = new NetSession(this, msg);
        this.handlers.match(msg);
        break;
      case 'roster':
        this.session?.setRoster(msg.roster);
        break;
      case 'snap':
        this.session?.onSnap(msg);
        break;
      case 'end':
        this.session?.onEnd(msg);
        this.handlers.end(msg);
        break;
      case 'pong':
        this.rtt = performance.now() - msg.c;
        break;
      case 'notice':
        this.handlers.notice(msg.msg);
        break;
    }
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  get isHost(): boolean {
    return !!this.room && this.room.host === this.room.you;
  }

  leave(): void {
    this.send({ t: 'leave' });
    this.left = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.stopPing();
    this.session?.dispose();
    this.session = null;
    try {
      this.ws?.close(1000, 'left');
    } catch {
      // Already closed.
    }
    this.ws = null;
  }
}

interface Snapshot {
  tick: number;
  players: Map<number, PlayerSnap>;
}

/** Remote players render this many ticks behind the newest snapshot. */
const INTERP_TICKS = 7;

/**
 * Online match view. The local player is predicted by running the shared player
 * step on local inputs, then corrected against each authoritative snapshot by
 * replaying unacknowledged inputs. Everyone else is interpolated between snapshots.
 */
export class NetSession implements Session {
  readonly online = true;
  view: GameView;
  meId: number;
  settings: MatchSettings;
  ended: EndMsg | null = null;
  private roster = new Map<number, RosterEntry>();
  private pred: Player;
  private havePred = false;
  private pending: InputFrame[] = [];
  private outbox: [number, number, number, number][] = [];
  private seq = 0;
  private acc = 0;
  private buffer: Snapshot[] = [];
  private clientTick = -1;
  private latestTick = 0;
  private match: MatchState;
  private pickups: PickupState[] = [];
  private heavy: { list: HeavyProjectile[]; at: number } = { list: [], at: 0 };
  private scores = new Map<number, [number, number, number, number]>();
  private events: GameEvent[] = [];
  private offset = { x: 0, y: 0 };
  private nextCosmeticId = -1;
  private liveCtx: PlayerCtx;
  private silentCtx: PlayerCtx;

  constructor(private net: NetClient, msg: MatchMsg) {
    this.meId = msg.you;
    this.settings = msg.settings;
    this.setRoster(msg.roster);
    const me = this.roster.get(this.meId);
    this.pred = newPlayer(this.meId, me?.name ?? '', me?.team ?? -1, me?.color ?? 0, false);
    this.match = { phase: 'countdown', mode: msg.settings.mode, timeLeft: 3, killLimit: msg.settings.killLimit, teamScores: [0, 0], winner: -1 };
    const map = getMap(msg.settings.map);
    const noop = () => undefined;
    this.liveCtx = {
      map,
      frozen: true,
      rand: Math.random,
      fire: (p, def, aim) => {
        const ox = p.x;
        const oy = p.y + SHOULDER_Y;
        this.events.push({ k: 'shot', p: p.id, w: def.id, x: ox + Math.cos(aim) * 0.95, y: oy + Math.sin(aim) * 0.95, a: aim });
        if (def.kind !== 'bullet') return;
        for (let i = 0; i < def.pellets; i++) {
          const a = aim + (Math.random() * 2 - 1) * def.spread;
          const sp = def.speed * (def.pellets > 1 ? 0.85 + Math.random() * 0.3 : 1);
          this.events.push({ k: 'bullet', id: this.nextCosmeticId--, p: p.id, w: def.id, x: ox, y: oy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: def.life });
        }
      },
      grenade: noop,
      emit: (e) => this.events.push(e),
    };
    this.silentCtx = { ...this.liveCtx, fire: noop, grenade: noop, emit: noop };
    this.view = this.buildView(0);
  }

  setRoster(list: RosterEntry[]): void {
    this.roster = new Map(list.map((r) => [r.id, r]));
  }

  onSnap(msg: SnapMsg): void {
    const players = new Map<number, PlayerSnap>();
    for (const p of msg.p) players.set(p[0], p);
    this.buffer.push({ tick: msg.tick, players });
    this.latestTick = Math.max(this.latestTick, msg.tick);
    if (this.clientTick < 0) this.clientTick = msg.tick - INTERP_TICKS;
    while (this.buffer.length > 2 && this.buffer[1].tick < this.clientTick - 2) this.buffer.shift();
    if (this.buffer.length > 40) this.buffer.splice(0, this.buffer.length - 40);

    this.match = msg.m;
    this.liveCtx.frozen = this.silentCtx.frozen = msg.m.phase !== 'live';
    this.pickups = msg.k.map(decodePickup);
    this.heavy = { list: msg.h, at: performance.now() };
    for (const s of msg.sc) this.scores.set(s[0], [s[1], s[2], s[3], s[4]]);

    for (const e of msg.ev) {
      // The local player's own shots, reloads and swaps were already shown by prediction.
      if ((e.k === 'shot' || e.k === 'bullet' || e.k === 'reload' || e.k === 'swap') && e.p === this.meId) continue;
      this.events.push(e);
    }

    if (msg.me) {
      const wasAlive = this.havePred && this.pred.alive;
      const beforeX = this.pred.x;
      const beforeY = this.pred.y;
      applyPredicted(this.pred, msg.me);
      this.pending = this.pending.filter((i) => i.seq > msg.ack);
      for (const input of this.pending) stepPlayer(this.pred, input, this.silentCtx);
      this.pred.px = this.pred.x;
      this.pred.py = this.pred.y;
      if (wasAlive && this.pred.alive) {
        const ex = beforeX - this.pred.x;
        const ey = beforeY - this.pred.y;
        // Small corrections blend out over a few frames; large ones snap.
        if (Math.hypot(ex, ey) < 3) {
          this.offset.x += ex;
          this.offset.y += ey;
        } else {
          this.offset.x = this.offset.y = 0;
        }
      } else {
        this.offset.x = this.offset.y = 0;
      }
      this.havePred = true;
    }
  }

  onEnd(msg: EndMsg): void {
    this.ended = msg;
    this.match = msg.match;
  }

  update(dt: number, sample: InputSampler): void {
    dt = Math.min(dt, 0.1);
    this.acc += dt;
    while (this.acc >= DT) {
      this.acc -= DT;
      const s = sample();
      const input: InputFrame = { seq: ++this.seq, b: s.b, mx: s.mx, aim: s.aim };
      this.pending.push(input);
      if (this.pending.length > 120) this.pending.shift();
      this.outbox.push([input.seq, input.b, input.mx, Math.round(input.aim * 1000) / 1000]);
      if (this.havePred) stepPlayer(this.pred, input, this.liveCtx);
    }
    if (this.outbox.length >= 2) {
      this.net.send({ t: 'in', i: this.outbox });
      this.outbox = [];
    }

    // Keep the render clock a fixed distance behind the newest snapshot.
    if (this.clientTick >= 0) {
      this.clientTick += dt * TICK_RATE;
      const target = this.latestTick - INTERP_TICKS;
      const diff = target - this.clientTick;
      if (Math.abs(diff) > 20) this.clientTick = target;
      else this.clientTick += diff * Math.min(1, dt * 3);
    }
    const decay = Math.exp(-dt * 12);
    this.offset.x *= decay;
    this.offset.y *= decay;
    this.view = this.buildView(this.acc / DT);
  }

  private interpolated(): Map<number, PlayerSnap> {
    const buf = this.buffer;
    const out = new Map<number, PlayerSnap>();
    if (!buf.length) return out;
    const t = this.clientTick;
    let a = buf[0];
    let b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].tick <= t && buf[i + 1].tick >= t) {
        a = buf[i];
        b = buf[i + 1];
        break;
      }
    }
    if (t >= b.tick) {
      // Ran past the newest snapshot: extrapolate briefly.
      const ahead = Math.min(6, t - b.tick) * DT;
      for (const [id, s] of b.players) {
        const c = s.slice() as PlayerSnap;
        c[1] += s[3] * ahead;
        c[2] += s[4] * ahead;
        out.set(id, c);
      }
      return out;
    }
    const f = b.tick > a.tick ? Math.max(0, Math.min(1, (t - a.tick) / (b.tick - a.tick))) : 1;
    for (const [id, sb] of b.players) {
      const sa = a.players.get(id);
      const c = sb.slice() as PlayerSnap;
      // Do not slide across a respawn.
      if (sa && (sa[8] & FLAG.alive) === (sb[8] & FLAG.alive) && Math.hypot(sb[1] - sa[1], sb[2] - sa[2]) < 6) {
        c[1] = sa[1] + (sb[1] - sa[1]) * f;
        c[2] = sa[2] + (sb[2] - sa[2]) * f;
        let da = sb[5] - sa[5];
        if (da > Math.PI) da -= Math.PI * 2;
        if (da < -Math.PI) da += Math.PI * 2;
        c[5] = sa[5] + da * f;
      }
      out.set(id, c);
    }
    return out;
  }

  private buildView(alpha: number): GameView {
    const players: ViewPlayer[] = [];
    for (const [id, s] of this.interpolated()) {
      const r = this.roster.get(id);
      if (!r) continue;
      const sc = this.scores.get(id) ?? [0, 0, 0, 0];
      if (id === this.meId && this.havePred) {
        const v = viewFromPlayer(this.pred, alpha);
        v.x += this.offset.x;
        v.y += this.offset.y;
        Object.assign(v, { name: r.name, team: r.team, color: r.color, kills: sc[0], deaths: sc[1], assists: sc[2], score: sc[3] });
        players.push(v);
        continue;
      }
      const f = s[8];
      players.push({
        id, name: r.name, team: r.team, color: r.color, bot: r.bot,
        x: s[1], y: s[2], vx: s[3], vy: s[4], aim: s[5], hp: s[6], armor: s[7],
        alive: (f & FLAG.alive) !== 0, grounded: (f & FLAG.grounded) !== 0, jetting: (f & FLAG.jetting) !== 0,
        reloading: (f & FLAG.reloading) !== 0, protect: (f & FLAG.protect) !== 0, overdrive: (f & FLAG.overdrive) !== 0,
        haste: (f & FLAG.haste) !== 0, weapon: WEAPON_INDEX[s[9]] ?? 'pistol',
        kills: sc[0], deaths: sc[1], assists: sc[2], score: sc[3],
      });
    }
    const since = (performance.now() - this.heavy.at) / 1000;
    const heavy = this.heavy.list.map((h) => ({ ...h, x: h.x + h.vx * since, y: h.y + h.vy * since }));
    return {
      meId: this.meId,
      players,
      heavy,
      pickups: this.pickups,
      match: this.match,
      settings: this.settings,
      hud: this.havePred ? hudFromPlayer(this.pred) : null,
    };
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  results(): ResultRow[] {
    return this.ended?.results ?? [];
  }

  shoulder() {
    if (!this.havePred) return null;
    return { x: this.pred.x + this.offset.x, y: this.pred.y + this.offset.y + SHOULDER_Y };
  }

  dispose(): void {
    this.events = [];
    this.buffer = [];
    this.pending = [];
  }
}
