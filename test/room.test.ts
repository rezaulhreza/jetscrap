import { describe, expect, it } from 'vitest';
import { Room, RECONNECT_GRACE, type Conn } from '../src/server/room';
import { Btn } from '../src/shared/constants';
import type { ServerMsg } from '../src/shared/protocol';

class FakeConn implements Conn {
  msgs: ServerMsg[] = [];
  closed: number | null = null;
  send(data: string) {
    this.msgs.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closed = code;
  }
  last<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }> | undefined {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === t) return this.msgs[i] as Extract<ServerMsg, { t: T }>;
    return undefined;
  }
}

function setup() {
  const room = new Room('ABCDE');
  let now = 1_000_000;
  const host = new FakeConn();
  room.connect(host, { name: 'Host', cid: 'h', create: true }, now);
  const guest = new FakeConn();
  room.connect(guest, { name: 'Guest', cid: 'g', create: false }, now);
  const advance = (seconds: number, each?: () => void) => {
    const end = now + seconds * 1000;
    while (now < end) {
      now += 16;
      each?.();
      room.tick(now);
    }
  };
  return { room, host, guest, advance, now: () => now };
}

describe('room', () => {
  it('rejects joins to rooms that were never created', () => {
    const room = new Room('ZZZZZ');
    const c = new FakeConn();
    expect(room.connect(c, { name: 'X', cid: 'x', create: false }, 0)).toBe(false);
    expect(c.last('error')?.code).toBe('not_found');
    expect(c.closed).not.toBeNull();
  });

  it('refuses a second create on an active code', () => {
    const { room } = setup();
    const c = new FakeConn();
    expect(room.connect(c, { name: 'X', cid: 'x', create: true }, 0)).toBe(false);
    expect(c.last('error')?.code).toBe('taken');
  });

  it('shares the lobby and only lets the host change settings', () => {
    const { room, host, guest } = setup();
    expect(guest.last('room')?.members.map((m) => m.name)).toEqual(['Host', 'Guest']);
    room.message(guest, JSON.stringify({ t: 'settings', s: { bots: 7 } }), 0);
    expect(room.settings.bots).toBe(2);
    room.message(host, JSON.stringify({ t: 'settings', s: { bots: 4, mode: 'tdm', map: 'nowhere', killLimit: 9999 } }), 0);
    expect(room.settings).toMatchObject({ bots: 4, mode: 'tdm', map: 'foundry', killLimit: 20 });
    room.message(guest, JSON.stringify({ t: 'team', team: 1 }), 0);
    expect(host.last('room')?.members.find((m) => m.cid === 'g')?.team).toBe(1);
  });

  it('runs an authoritative match with humans and bots', () => {
    const { room, host, guest, advance } = setup();
    room.message(host, JSON.stringify({ t: 'settings', s: { bots: 3, mode: 'tdm' } }), 0);
    room.message(host, JSON.stringify({ t: 'start' }), 0);
    const match = guest.last('match')!;
    expect(match.roster.length).toBe(5);
    expect(match.roster.filter((r) => r.bot).length).toBe(3);
    // Teams are balanced 3 v 2 or better.
    const t0 = match.roster.filter((r) => r.team === 0).length;
    expect(Math.abs(t0 - (5 - t0))).toBeLessThanOrEqual(1);

    advance(3.5);
    const me = guest.last('snap')!.me!;
    const x0 = me.x;
    let seq = 0;
    advance(1, () => room.message(guest, JSON.stringify({ t: 'in', i: [[++seq, 0, 1, 0]] }), 0));
    const snap = guest.last('snap')!;
    expect(snap.me!.x).toBeGreaterThan(x0 + 3);
    expect(snap.ack).toBeGreaterThan(seq - 6);
    expect(snap.p.length).toBe(5);
  });

  it('caps movement when a client floods inputs', () => {
    const { room, host, guest, advance } = setup();
    room.message(host, JSON.stringify({ t: 'settings', s: { bots: 0 } }), 0);
    room.message(host, JSON.stringify({ t: 'start' }), 0);
    advance(3.5);
    const x0 = guest.last('snap')!.me!.x;
    let seq = 0;
    // Ten inputs every 16 ms is ten times the tick rate.
    advance(0.5, () => room.message(guest, JSON.stringify({ t: 'in', i: Array.from({ length: 10 }, () => [++seq, 0, 1, 0]) }), 0));
    const dx = Math.abs(guest.last('snap')!.me!.x - x0);
    // Normal running covers about 4 units in 0.5 s; catch-up can at most double that.
    expect(dx).toBeLessThan(9);
  });

  it('ignores malformed messages', () => {
    const { room, guest } = setup();
    expect(() => {
      room.message(guest, 'not json', 0);
      room.message(guest, JSON.stringify({ t: 'in', i: [['x', 1, 2, 3], [1, Btn.Fire, 0, 'nan']] }), 0);
      room.message(guest, JSON.stringify(null), 0);
    }).not.toThrow();
  });

  it('keeps a disconnected player for the grace period and lets them reconnect', () => {
    const { room, host, guest, advance, now } = setup();
    room.message(host, JSON.stringify({ t: 'start' }), 0);
    advance(1);
    const id = guest.last('match')!.you;
    room.disconnect(guest, now());
    advance(5);
    expect(room.world!.players.has(id)).toBe(true);
    const again = new FakeConn();
    room.connect(again, { name: 'Guest', cid: 'g', create: false }, 0);
    expect(again.last('match')!.you).toBe(id);
    room.disconnect(again, now());
    advance(RECONNECT_GRACE + 1);
    expect(room.world!.players.has(id)).toBe(false);
  });

  it('removes a player who leaves on purpose straight away', () => {
    const { room, host, guest } = setup();
    room.message(host, JSON.stringify({ t: 'start' }), 0);
    const id = guest.last('match')!.you;
    room.message(guest, JSON.stringify({ t: 'leave' }), 0);
    expect(room.world!.players.has(id)).toBe(false);
    expect(host.last('room')!.members.map((m) => m.cid)).toEqual(['h']);
    expect(host.last('notice')!.msg).toBe('Guest left');
  });

  it('moves host to another player when the host leaves', () => {
    const { room, host, guest } = setup();
    room.disconnect(host, 0);
    expect(room.host).toBe('g');
    expect(guest.last('room')!.host).toBe('g');
  });

  it('ends the match, reports results and supports a rematch', () => {
    const { room, host, guest, advance } = setup();
    room.message(host, JSON.stringify({ t: 'settings', s: { bots: 0, timeLimit: 120 } }), 0);
    room.message(host, JSON.stringify({ t: 'start' }), 0);
    advance(124);
    const end = guest.last('end');
    expect(end).toBeDefined();
    expect(end!.results.length).toBe(2);
    expect(room.phase).toBe('results');
    room.message(host, JSON.stringify({ t: 'start' }), 0);
    expect(room.phase).toBe('match');
    expect(room.world!.match.phase).toBe('countdown');
  });
});
