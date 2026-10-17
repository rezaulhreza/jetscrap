import { Btn, DT, MAX_HUMANS, MAX_PLAYERS, SNAPSHOT_EVERY } from '../shared/constants';
import { capturePredicted } from '../shared/player';
import {
  cleanName, encodePickup, encodePlayer, packJson, readInput,
  type ClientMsg, type ErrorCode, type MemberInfo, type RoomPhase, type RosterEntry, type ServerMsg,
} from '../shared/protocol';
import { BOT_NAMES } from '../shared/bots';
import { World } from '../shared/sim';
import {
  DEFAULT_SETTINGS, DIFFICULTIES, KILL_LIMITS, TIME_LIMITS, type InputFrame, type MatchSettings,
} from '../shared/types';
import { MAP_IDS } from '../shared/maps';

/** A client connection. The Durable Object wraps a WebSocket; tests use a fake. */
export interface Conn {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface JoinParams {
  name: string;
  cid: string;
  create: boolean;
}

interface Member {
  cid: string;
  name: string;
  team: number;
  conn: Conn | null;
  playerId: number;
  queue: InputFrame[];
  last: InputFrame;
  lastSeq: number;
  ack: number;
  leftAt: number;
  msgWindow: number;
  msgCount: number;
}

/** Seconds a disconnected player keeps their slot so they can reconnect. */
export const RECONNECT_GRACE = 20;
/** Seconds an empty room stays open before it shuts down. */
export const EMPTY_ROOM_TTL = 60;
const MAX_QUEUE = 10;
const MAX_MSGS_PER_SEC = 90;

/**
 * One private room: lobby, team selection, settings, and the authoritative match.
 * The room owns a World and steps it at the fixed tick rate. Clients only send
 * inputs; the World decides movement, fire rates, damage, deaths and scoring.
 */
export class Room {
  created = false;
  phase: RoomPhase = 'lobby';
  host = '';
  settings: MatchSettings = { ...DEFAULT_SETTINGS, bots: 2 };
  world: World | null = null;
  private members = new Map<string, Member>();
  private acc = 0;
  private lastNow = 0;
  private emptySince = 0;
  private endSent = false;

  constructor(readonly code: string) {}

  /** True while the room needs its tick loop. */
  get alive(): boolean {
    return this.created && (this.connectedCount() > 0 || this.lastNow - this.emptySince < EMPTY_ROOM_TTL * 1000);
  }

  connectedCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.conn) n++;
    return n;
  }

  // ------------------------------------------------------------- connections

  connect(conn: Conn, params: JoinParams, now: number): boolean {
    const name = cleanName(params.name);
    const cid = String(params.cid || '').slice(0, 40);
    if (!cid) return this.reject(conn, 'bad_request', 'Missing client id.');

    if (params.create) {
      if (this.created && this.connectedCount() > 0 && !this.members.has(cid)) {
        return this.reject(conn, 'taken', 'That room code is in use. Try again.');
      }
      if (!this.created || this.connectedCount() === 0) this.reset(cid);
    } else if (!this.created) {
      return this.reject(conn, 'not_found', 'No room with that code. Check the code with your host.');
    }

    let m = this.members.get(cid);
    if (m) {
      // Reconnect: take over the existing slot.
      m.conn?.close(4000, 'Replaced by a new connection');
      m.conn = conn;
      m.name = name;
      m.leftAt = 0;
    } else {
      if (this.members.size >= MAX_HUMANS) return this.reject(conn, 'full', 'This room is full.');
      m = {
        cid, name, team: this.smallerHumanTeam(), conn, playerId: 0, queue: [], last: { seq: 0, b: 0, mx: 0, aim: 0 },
        lastSeq: -1, ack: 0, leftAt: 0, msgWindow: now, msgCount: 0,
      };
      this.members.set(cid, m);
      this.broadcastNotice(`${name} joined`, cid);
    }
    if (!this.host || !this.members.get(this.host)?.conn) this.host = cid;
    this.lastNow = now;

    if (this.world && this.phase !== 'lobby') {
      if (!m.playerId || !this.world.players.has(m.playerId)) this.addToWorld(m);
      this.sendMatch(m);
      if (this.phase === 'results') this.sendTo(m, { t: 'end', results: this.world.results(), match: this.world.match });
    }
    this.broadcastRoom();
    return true;
  }

  disconnect(conn: Conn, now: number): void {
    for (const m of this.members.values()) {
      if (m.conn !== conn) continue;
      m.conn = null;
      m.leftAt = now;
      m.queue.length = 0;
      m.last = { ...m.last, b: 0, mx: 0 };
      if (this.phase === 'lobby') {
        this.members.delete(m.cid);
        this.broadcastNotice(`${m.name} left`);
      } else {
        this.broadcastNotice(`${m.name} disconnected`);
      }
      if (this.host === m.cid) this.pickHost();
      if (this.connectedCount() === 0) this.emptySince = now;
      this.broadcastRoom();
      return;
    }
  }

  message(conn: Conn, raw: string, now: number): void {
    const m = [...this.members.values()].find((x) => x.conn === conn);
    if (!m) return;
    if (now - m.msgWindow > 1000) {
      m.msgWindow = now;
      m.msgCount = 0;
    }
    if (++m.msgCount > MAX_MSGS_PER_SEC) {
      if (m.msgCount > MAX_MSGS_PER_SEC * 4) conn.close(4008, 'Too many messages');
      return;
    }
    if (typeof raw !== 'string' || raw.length > 4096) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'in':
        this.onInputs(m, msg.i);
        break;
      case 'ping':
        if (Number.isFinite(msg.c)) this.sendTo(m, { t: 'pong', c: msg.c });
        break;
      case 'team':
        if ((msg.team === 0 || msg.team === 1) && this.phase === 'lobby') {
          m.team = msg.team;
          this.broadcastRoom();
        }
        break;
      case 'settings':
        if (m.cid === this.host && this.phase === 'lobby') {
          this.settings = sanitiseSettings({ ...this.settings, ...msg.s });
          this.broadcastRoom();
        }
        break;
      case 'start':
        if (m.cid === this.host && this.phase !== 'match') this.startMatch(now);
        break;
      case 'lobby':
        if (m.cid === this.host && this.phase === 'results') this.toLobby();
        break;
      case 'leave':
        this.removeMember(m, `${m.name} left`);
        conn.close(1000, 'left');
        break;
    }
  }

  // ------------------------------------------------------------- match

  private startMatch(now: number): void {
    this.world = new World(this.settings, now);
    this.phase = 'match';
    this.endSent = false;
    this.acc = 0;
    for (const m of this.members.values()) {
      m.playerId = 0;
      m.queue.length = 0;
      m.lastSeq = -1;
      m.ack = 0;
    }
    for (const m of this.members.values()) if (m.conn) this.addToWorld(m);
    // Drop members who are still away when a new match starts.
    for (const m of [...this.members.values()]) if (!m.conn) this.members.delete(m.cid);
    this.fillBots();
    for (const m of this.members.values()) this.sendMatch(m);
    this.broadcastRoom();
  }

  private toLobby(): void {
    this.world = null;
    this.phase = 'lobby';
    for (const m of [...this.members.values()]) {
      m.playerId = 0;
      if (!m.conn) this.members.delete(m.cid);
    }
    this.broadcastRoom();
  }

  private addToWorld(m: Member): void {
    const w = this.world!;
    if (w.players.size >= MAX_PLAYERS) this.removeOneBot(this.settings.mode === 'tdm' ? m.team : undefined);
    const p = w.addPlayer({ name: m.name, team: this.settings.mode === 'tdm' ? m.team : undefined });
    if (!p) return;
    m.playerId = p.id;
    m.lastSeq = -1;
    m.queue.length = 0;
    this.broadcastRoster();
  }

  private fillBots(): void {
    const w = this.world!;
    const humans = w.players.size;
    const count = Math.max(0, Math.min(this.settings.bots, MAX_PLAYERS - humans));
    for (let i = 0; i < count; i++) {
      const team = this.settings.mode === 'tdm' ? w.smallerTeam() : undefined;
      w.addPlayer({ name: BOT_NAMES[i % BOT_NAMES.length], team, bot: this.settings.difficulty });
    }
  }

  private removeOneBot(team?: number): void {
    const w = this.world!;
    const bots = [...w.players.values()].filter((p) => p.bot);
    const pick = bots.find((p) => team === undefined || p.team === team) ?? bots[0];
    if (pick) w.removePlayer(pick.id);
  }

  private onInputs(m: Member, list: unknown): void {
    if (!this.world || !m.playerId || !Array.isArray(list)) return;
    for (const raw of list.slice(0, MAX_QUEUE)) {
      const input = readInput(raw);
      if (!input || input.seq <= m.lastSeq) continue;
      m.lastSeq = input.seq;
      m.queue.push(input);
    }
    // A client that sends faster than the tick rate cannot move faster: excess inputs are dropped.
    if (m.queue.length > MAX_QUEUE) m.queue.splice(0, m.queue.length - MAX_QUEUE);
  }

  /** Advances the room clock. Call often (every ~16 ms); it steps the world at the fixed tick rate. */
  tick(now: number): void {
    if (!this.lastNow) this.lastNow = now;
    const elapsed = Math.min(0.25, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;

    // Expire members who did not come back.
    for (const m of [...this.members.values()]) {
      if (!m.conn && m.leftAt && now - m.leftAt > RECONNECT_GRACE * 1000) this.removeMember(m, `${m.name} left`);
    }

    const w = this.world;
    if (!w || this.phase === 'lobby') return;
    this.acc += elapsed;
    let steps = 0;
    while (this.acc >= DT && steps < 5) {
      this.acc -= DT;
      steps++;
      for (const m of this.members.values()) {
        if (!m.playerId) continue;
        // Catch up when the queue builds; repeat the held buttons when it runs dry.
        let input = m.queue.shift();
        if (input && m.queue.length > 3) input = m.queue.shift() ?? input;
        if (input) {
          m.last = input;
          m.ack = input.seq;
        } else {
          input = { ...m.last, b: m.last.b & (Btn.Up | Btn.Down | Btn.Fire) };
        }
        w.setInput(m.playerId, input);
      }
      w.step();
      if (w.tick % SNAPSHOT_EVERY === 0) this.sendSnapshots();
    }
    if (this.acc > DT * 5) this.acc = 0;

    if (w.match.phase === 'ended' && !this.endSent) {
      this.sendSnapshots();
      this.endSent = true;
      this.phase = 'results';
      this.broadcast({ t: 'end', results: w.results(), match: w.match });
      this.broadcastRoom();
    }
  }

  private sendSnapshots(): void {
    const w = this.world!;
    const players = [...w.players.values()];
    const base = packJson({
      tick: w.tick,
      p: players.map(encodePlayer),
      h: w.heavyProjectiles,
      k: w.pickupStates.map(encodePickup),
      m: w.match,
      sc: players.map((p) => [p.id, p.kills, p.deaths, p.assists, p.score]),
      ev: w.drainEvents(),
    });
    for (const m of this.members.values()) {
      if (!m.conn) continue;
      const p = m.playerId ? w.players.get(m.playerId) : undefined;
      const head = `{"t":"snap","ack":${m.ack},"me":${p ? packJson(capturePredicted(p)) : 'null'},`;
      this.safeSend(m, head + base.slice(1));
    }
  }

  // ------------------------------------------------------------- helpers

  private reset(hostCid: string): void {
    this.created = true;
    this.members.clear();
    this.phase = 'lobby';
    this.world = null;
    this.host = hostCid;
    this.settings = { ...DEFAULT_SETTINGS, bots: 2 };
  }

  /** Removes a member and their player straight away (a deliberate leave or an expired reconnect). */
  private removeMember(m: Member, notice: string): void {
    this.members.delete(m.cid);
    m.conn = null;
    if (this.world && m.playerId) {
      this.world.removePlayer(m.playerId);
      this.broadcastRoster();
    }
    if (this.host === m.cid) this.pickHost();
    if (this.connectedCount() === 0) this.emptySince = this.lastNow;
    this.broadcastNotice(notice);
    this.broadcastRoom();
  }

  private pickHost(): void {
    const next = [...this.members.values()].find((m) => m.conn);
    this.host = next ? next.cid : '';
  }

  private smallerHumanTeam(): number {
    let a = 0;
    let b = 0;
    for (const m of this.members.values()) (m.team === 0 ? a++ : b++);
    return a <= b ? 0 : 1;
  }

  roster(): RosterEntry[] {
    if (!this.world) return [];
    return [...this.world.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, color: p.color, bot: p.bot }));
  }

  private sendMatch(m: Member): void {
    this.sendTo(m, { t: 'match', settings: this.settings, you: m.playerId, roster: this.roster() });
  }

  private broadcastRoster(): void {
    this.broadcast({ t: 'roster', roster: this.roster() });
  }

  private broadcastRoom(): void {
    const members: MemberInfo[] = [...this.members.values()].map((m) => ({ cid: m.cid, name: m.name, team: m.team, connected: !!m.conn }));
    for (const m of this.members.values()) {
      this.sendTo(m, { t: 'room', code: this.code, you: m.cid, host: this.host, phase: this.phase, settings: this.settings, members });
    }
  }

  private broadcastNotice(msg: string, except?: string): void {
    for (const m of this.members.values()) if (m.cid !== except) this.sendTo(m, { t: 'notice', msg });
  }

  private broadcast(msg: ServerMsg): void {
    const s = packJson(msg);
    for (const m of this.members.values()) this.safeSend(m, s);
  }

  private sendTo(m: Member, msg: ServerMsg): void {
    this.safeSend(m, packJson(msg));
  }

  private safeSend(m: Member, s: string): void {
    if (!m.conn) return;
    try {
      m.conn.send(s);
    } catch {
      // The close handler cleans up.
    }
  }

  private reject(conn: Conn, code: ErrorCode, msg: string): false {
    try {
      conn.send(packJson({ t: 'error', code, msg } satisfies ServerMsg));
      conn.close(4001, code);
    } catch {
      // Already closed.
    }
    return false;
  }
}

export function sanitiseSettings(s: MatchSettings): MatchSettings {
  const pick = <T>(v: T, allowed: readonly T[], fallback: T) => (allowed.includes(v) ? v : fallback);
  return {
    mode: s.mode === 'tdm' ? 'tdm' : 'ffa',
    map: pick(s.map, MAP_IDS, DEFAULT_SETTINGS.map),
    timeLimit: pick(Number(s.timeLimit), TIME_LIMITS, DEFAULT_SETTINGS.timeLimit),
    killLimit: pick(Number(s.killLimit), KILL_LIMITS, DEFAULT_SETTINGS.killLimit),
    bots: Math.max(0, Math.min(MAX_PLAYERS - 1, Math.floor(Number(s.bots) || 0))),
    difficulty: pick(s.difficulty, DIFFICULTIES, DEFAULT_SETTINGS.difficulty),
  };
}
