import { describe, expect, it } from 'vitest';
import { Btn, PLAYER_H, PLAYER_W, RESPAWN_TIME, TICK_RATE } from '../src/shared/constants';
import { MAPS } from '../src/shared/maps';
import { navFor } from '../src/shared/nav';
import { boxOverlapsRect, groundBelow } from '../src/shared/physics';
import { World } from '../src/shared/sim';
import { DEFAULT_SETTINGS, type InputFrame, type MatchSettings } from '../src/shared/types';

const settings = (over: Partial<MatchSettings> = {}): MatchSettings => ({ ...DEFAULT_SETTINGS, bots: 0, ...over });

function run(world: World, seconds: number, each?: () => void) {
  for (let i = 0; i < seconds * TICK_RATE; i++) {
    each?.();
    world.step();
    world.drainEvents();
  }
}

function skipCountdown(world: World) {
  run(world, 3.1);
  expect(world.match.phase).toBe('live');
}

describe('maps', () => {
  for (const map of Object.values(MAPS)) {
    it(`${map.id}: spawns and items sit on free ground`, () => {
      for (const s of map.spawns) {
        const blocked = map.solids.some((r) => boxOverlapsRect(s.x - PLAYER_W / 2, s.y + 0.01, PLAYER_W, PLAYER_H, r));
        expect(blocked, `spawn ${s.x},${s.y} inside a solid`).toBe(false);
        expect(Math.abs(groundBelow(map, s.x, s.y) - s.y), `spawn ${s.x},${s.y} floats`).toBeLessThan(0.05);
      }
      for (const it of map.items) {
        expect(Math.abs(groundBelow(map, it.x, it.y) - it.y), `item ${it.kind} at ${it.x},${it.y} floats`).toBeLessThan(0.05);
      }
      expect(map.spawns.filter((s) => s.team === 0).length).toBeGreaterThanOrEqual(4);
    });

    it(`${map.id}: every spawn can reach every other spawn`, () => {
      const nav = navFor(map);
      const [a, ...rest] = map.spawns;
      for (const b of rest) expect(nav.findPath(a.x, a.y, b.x, b.y, 20000), `${a.x},${a.y} -> ${b.x},${b.y}`).not.toBeNull();
    });
  }
});

describe('movement', () => {
  it('lands on the floor, runs, and jumps', () => {
    const w = new World(settings(), 1);
    const p = w.addPlayer({ name: 'A' })!;
    skipCountdown(w);
    expect(p.grounded).toBe(true);
    const x0 = p.x;
    run(w, 0.5, () => w.setInput(p.id, { seq: 0, b: 0, mx: 1, aim: 0 }));
    expect(p.x).toBeGreaterThan(x0 + 2);
    w.setInput(p.id, { seq: 0, b: Btn.Up, mx: 0, aim: 0 });
    w.step();
    expect(p.vy).toBeGreaterThan(5);
  });

  it('burns fuel while the jetpack fires and refills on the ground', () => {
    const w = new World(settings(), 2);
    const p = w.addPlayer({ name: 'A' })!;
    skipCountdown(w);
    run(w, 1, () => w.setInput(p.id, { seq: 0, b: Btn.Up, mx: 0, aim: 0 }));
    expect(p.fuel).toBeLessThan(70);
    run(w, 3, () => w.setInput(p.id, { seq: 0, b: 0, mx: 0, aim: 0 }));
    expect(p.fuel).toBe(100);
  });
});

describe('combat', () => {
  function duel() {
    const w = new World(settings({ map: 'foundry' }), 3);
    const a = w.addPlayer({ name: 'A' })!;
    const b = w.addPlayer({ name: 'B' })!;
    skipCountdown(w);
    run(w, 2.1);
    // Put both on the open floor, 6 units apart, facing each other.
    Object.assign(a, { x: 18, y: 2, vx: 0, vy: 0, protect: 0 });
    Object.assign(b, { x: 24, y: 2, vx: 0, vy: 0, protect: 0 });
    return { w, a, b };
  }

  it('rate-limits fire to the weapon interval', () => {
    const { w, a } = duel();
    let shots = 0;
    for (let i = 0; i < TICK_RATE; i++) {
      w.setInput(a.id, { seq: i, b: Btn.Fire, mx: 0, aim: Math.PI / 2 });
      w.step();
      shots += w.drainEvents().filter((e) => e.k === 'shot' && e.p === a.id).length;
    }
    // Hornet AR: 0.095 s interval, 30 rounds, so about 11 shots in one second.
    expect(shots).toBeGreaterThanOrEqual(10);
    expect(shots).toBeLessThanOrEqual(11);
  });

  it('kills, credits the killer, drops the weapon and respawns the victim', () => {
    const { w, a, b } = duel();
    let killed = false;
    for (let i = 0; i < 3 * TICK_RATE && !killed; i++) {
      w.setInput(a.id, { seq: i, b: Btn.Fire, mx: 0, aim: 0.06 });
      w.setInput(b.id, { seq: i, b: 0, mx: 0, aim: Math.PI });
      b.x = 24;
      w.step();
      killed = w.drainEvents().some((e) => e.k === 'kill' && e.p === b.id && e.by === a.id);
    }
    expect(killed).toBe(true);
    expect(a.kills).toBe(1);
    expect(b.deaths).toBe(1);
    expect(b.alive).toBe(false);
    expect(w.pickupStates.some((p) => p.dropped && p.weapon === 'rifle')).toBe(true);
    run(w, RESPAWN_TIME + 0.1);
    expect(b.alive).toBe(true);
    expect(b.protect).toBeGreaterThan(0);
  });

  it('ignores damage during spawn protection and between teammates', () => {
    const w = new World(settings({ mode: 'tdm' }), 4);
    const a = w.addPlayer({ name: 'A', team: 0 })!;
    const b = w.addPlayer({ name: 'B', team: 0 })!;
    const c = w.addPlayer({ name: 'C', team: 1 })!;
    skipCountdown(w);
    c.protect = 1;
    w.damage(c, 50, a.id, 'rifle', false, 0, 0);
    expect(c.hp).toBe(100);
    b.protect = 0;
    w.damage(b, 50, a.id, 'rifle', false, 0, 0);
    expect(b.hp).toBe(100);
  });

  it('armour absorbs part of the damage', () => {
    const w = new World(settings(), 5);
    const a = w.addPlayer({ name: 'A' })!;
    const b = w.addPlayer({ name: 'B' })!;
    skipCountdown(w);
    Object.assign(b, { protect: 0, armor: 50 });
    w.damage(b, 40, a.id, 'rifle', false, 0, 0);
    expect(b.armor).toBeCloseTo(26);
    expect(b.hp).toBeCloseTo(84);
  });

  it('credits assists', () => {
    const w = new World(settings(), 6);
    const a = w.addPlayer({ name: 'A' })!;
    const b = w.addPlayer({ name: 'B' })!;
    const c = w.addPlayer({ name: 'C' })!;
    skipCountdown(w);
    for (const p of [a, b, c]) p.protect = 0;
    w.damage(c, 40, b.id, 'rifle', false, 0, 0);
    w.damage(c, 70, a.id, 'rifle', false, 0, 0);
    expect(c.alive).toBe(false);
    expect(a.kills).toBe(1);
    expect(b.assists).toBe(1);
  });

  it('ends the match at the kill limit', () => {
    const w = new World(settings({ killLimit: 2 }), 7);
    const a = w.addPlayer({ name: 'A' })!;
    const b = w.addPlayer({ name: 'B' })!;
    skipCountdown(w);
    for (let i = 0; i < 2; i++) {
      b.protect = 0;
      w.damage(b, 200, a.id, 'sniper', true, 0, 0);
      run(w, RESPAWN_TIME + 0.1);
    }
    expect(w.match.phase).toBe('ended');
    expect(w.match.winner).toBe(a.id);
  });

  it('ignores malformed input values', () => {
    const w = new World(settings(), 8);
    const a = w.addPlayer({ name: 'A' })!;
    skipCountdown(w);
    const bad = { seq: 1, b: 0, mx: 50, aim: Number.NaN } as InputFrame;
    run(w, 1, () => w.setInput(a.id, bad));
    expect(Number.isFinite(a.aim)).toBe(true);
    expect(Math.abs(a.vx)).toBeLessThanOrEqual(8.5 + 1e-6);
  });
});

describe('bots', () => {
  for (const mode of ['ffa', 'tdm'] as const) {
    for (const map of Object.keys(MAPS)) {
      it(`fight a full ${mode} match on ${map}`, () => {
        const w = new World(settings({ mode, map, timeLimit: 120, killLimit: 999 }), 42);
        for (let i = 0; i < 8; i++) w.addPlayer({ name: `Bot${i}`, bot: (['easy', 'normal', 'hard', 'elite'] as const)[i % 4] });
        let shots = 0;
        let pickups = 0;
        const start = performance.now();
        for (let t = 0; t < 125 * TICK_RATE && w.match.phase !== 'ended'; t++) {
          w.step();
          for (const e of w.drainEvents()) {
            if (e.k === 'shot') shots++;
            if (e.k === 'pickup') pickups++;
          }
        }
        const ms = performance.now() - start;
        const kills = [...w.players.values()].reduce((s, p) => s + p.kills, 0);
        expect(w.match.phase).toBe('ended');
        expect(shots).toBeGreaterThan(200);
        expect(kills).toBeGreaterThan(8);
        expect(pickups).toBeGreaterThan(3);
        // 2 minutes of game time with 8 bots must simulate far faster than real time.
        expect(ms).toBeLessThan(8000);
        // eslint-disable-next-line no-console
        console.log(`${mode}/${map}: ${kills} kills, ${shots} shots, ${pickups} pickups, ${ms.toFixed(0)} ms, ${(ms / (120 * TICK_RATE)).toFixed(3)} ms/tick`);
      });
    }
  }
});
