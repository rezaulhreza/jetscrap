import { FUEL_MAX, MAX_ARMOR, MAX_HEALTH, PLAYER_H, TEAM_NAMES } from '../shared/constants';
import type { GameEvent, KillCause, ResultRow } from '../shared/types';
import { WEAPONS } from '../shared/weapons';
import type { GameRenderer } from './render/renderer';
import { TEAM_COLORS, playerColor } from './render/models';
import type { GameView, ViewPlayer } from './session';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function causeName(w: KillCause): string {
  if (w === 'grenade') return 'Grenade';
  if (w === 'hazard') return 'Hazard';
  if (w === 'fall') return 'Fall';
  return WEAPONS[w].name;
}

function fmtTime(s: number): string {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

interface DamageNumber {
  el: HTMLSpanElement;
  x: number;
  y: number;
  life: number;
}

/** DOM heads-up display. Reads the GameView each frame; reacts to events for feedback. */
export class Hud {
  private root = $('hud');
  private tags = new Map<number, { el: HTMLDivElement; bar: HTMLElement; name: string }>();
  private labels = $('labels');
  private feed = $('feed');
  private names = new Map<number, { name: string; team: number; color: number }>();
  private nums: DamageNumber[] = [];
  private hitmarkTime = 0;
  private vignette = 0;
  private toastTime = 0;
  private killedBy = '';
  private fpsAcc = { t: 0, n: 0 };
  showFps = false;
  touch = false;

  show(on: boolean): void {
    this.root.hidden = !on;
    this.labels.hidden = !on;
    if (!on) this.clear();
  }

  clear(): void {
    this.feed.innerHTML = '';
    for (const t of this.tags.values()) t.el.remove();
    this.tags.clear();
    for (const n of this.nums) n.el.remove();
    this.nums = [];
    this.killedBy = '';
    this.names.clear();
  }

  private nameHtml(id: number): string {
    const n = this.names.get(id);
    if (!n) return 'Someone';
    return `<b style="color:${playerColor(n.team, n.color)}">${esc(n.name)}</b>`;
  }

  toast(text: string): void {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    this.toastTime = 1.6;
  }

  events(view: GameView, events: GameEvent[]): void {
    for (const p of view.players) this.names.set(p.id, { name: p.name, team: p.team, color: p.color });
    const me = view.meId;
    for (const e of events) {
      switch (e.k) {
        case 'kill': {
          const li = document.createElement('li');
          const mine = e.by === me || e.p === me || e.as === me;
          if (mine) li.className = 'mine';
          const victim = this.nameHtml(e.p);
          if (!e.by) {
            const how = e.w === 'fall' ? 'fell' : e.w === 'hazard' ? 'was fried' : 'blew up';
            li.innerHTML = `${victim} <span class="w">${how}</span>`;
          } else {
            const assist = e.as ? ` <span class="w">+</span>${this.nameHtml(e.as)}` : '';
            const head = e.head ? ' (head)' : '';
            li.innerHTML = `${this.nameHtml(e.by)}${assist}<span class="w">${esc(causeName(e.w))}${head}</span>${victim}`;
          }
          this.feed.prepend(li);
          while (this.feed.children.length > 6) this.feed.lastElementChild?.remove();
          setTimeout(() => li.classList.add('fade'), 6000);
          setTimeout(() => li.remove(), 6500);
          if (e.by === me && e.p !== me) {
            this.hitmark(true);
            if (e.streak === 3) this.toast('Three in a row');
            else if (e.streak === 5) this.toast('Five in a row. Rampage');
            else if (e.streak >= 8 && e.streak % 2 === 0) this.toast(`${e.streak} in a row. Unstoppable`);
          }
          if (e.p === me) this.killedBy = e.by && e.by !== me ? this.names.get(e.by)?.name ?? '' : '';
          break;
        }
        case 'hit':
          if (e.by === me && e.p !== me) {
            this.hitmark(false);
            this.damageNumber(e.x, e.y, e.d, e.head);
          }
          if (e.p === me) this.vignette = Math.min(1, this.vignette + 0.25 + e.d / 60);
          break;
        case 'pickup':
          if (e.p === me) {
            const label = e.kind === 'weapon' && e.w ? WEAPONS[e.w].name
              : e.kind === 'health' ? '+50 health'
              : e.kind === 'armor' ? '+50 armour'
              : e.kind === 'ammo' ? 'Ammunition'
              : e.kind === 'grenades' ? 'Grenades'
              : e.kind === 'overdrive' ? 'Overdrive: 50% more damage'
              : 'Haste: speed and unlimited fuel';
            this.toast(label);
          }
          break;
      }
    }
  }

  private hitmark(kill: boolean): void {
    const h = $('hitmark');
    h.classList.add('show');
    h.classList.toggle('kill', kill);
    this.hitmarkTime = kill ? 0.35 : 0.14;
  }

  private damageNumber(x: number, y: number, d: number, head: boolean): void {
    const el = document.createElement('span');
    el.textContent = String(d);
    if (head) el.className = 'head';
    $('dmg-nums').append(el);
    this.nums.push({ el, x: x + (Math.random() - 0.5) * 0.4, y, life: 0.7 });
    if (this.nums.length > 24) this.nums.shift()!.el.remove();
  }

  update(view: GameView, dt: number, renderer: GameRenderer, cursor: { x: number; y: number }): void {
    const hud = view.hud;
    const m = view.match;

    // Timer, score and countdown.
    const timer = $('hud-timer');
    timer.textContent = m.phase === 'countdown' ? 'Get ready' : fmtTime(m.timeLeft);
    timer.classList.toggle('low', m.phase === 'live' && m.timeLeft < 30);
    const cd = $('countdown');
    cd.textContent = m.phase === 'countdown' ? String(Math.max(1, Math.ceil(m.timeLeft))) : '';
    this.renderScore(view);

    // Vitals and weapon.
    if (hud) {
      const hp = Math.max(0, hud.hp);
      $('hp-fill').style.width = `${(hp / MAX_HEALTH) * 100}%`;
      $('hp-text').textContent = String(Math.ceil(hp));
      $('hp-fill').parentElement!.classList.toggle('low', hp < 35);
      $('armor-fill').style.width = `${(hud.armor / MAX_ARMOR) * 100}%`;
      $('fuel-fill').style.width = `${(hud.fuel / FUEL_MAX) * 100}%`;
      $('fuel-fill').parentElement!.classList.toggle('empty', hud.fuel < 15);
      const def = WEAPONS[hud.weapon];
      $('weapon-name').textContent = def.name;
      const mag = $('ammo-mag');
      mag.textContent = String(hud.mag);
      mag.classList.toggle('empty', hud.mag === 0);
      $('ammo-reserve').textContent = hud.infinite ? '/ ∞' : `/ ${hud.reserve}`;
      const prim = $('slot-primary');
      prim.textContent = hud.primary ? WEAPONS[hud.primary].name : 'No gun';
      prim.className = hud.slot === 0 && hud.primary ? 'on' : '';
      const sec = $('slot-secondary');
      sec.textContent = WEAPONS.pistol.name;
      sec.className = hud.slot === 1 || !hud.primary ? 'on' : '';
      $('grenades').textContent = `Grenades ${hud.grenades}`;
      const rl = $('reload');
      rl.hidden = hud.reloadProgress === null;
      if (hud.reloadProgress !== null) (rl.firstElementChild as HTMLElement).style.width = `${hud.reloadProgress * 100}%`;
      const pu: string[] = [];
      if (hud.protect > 0) pu.push(`<span class="shield">Spawn shield</span>`);
      if (hud.overdrive > 0) pu.push(`<span class="overdrive">Overdrive ${Math.ceil(hud.overdrive)}</span>`);
      if (hud.haste > 0) pu.push(`<span class="haste">Haste ${Math.ceil(hud.haste)}</span>`);
      const html = pu.join('');
      const box = $('powerups');
      if (box.innerHTML !== html) box.innerHTML = html;
      const gap = 5 + def.spread * 140;
      $('crosshair').style.setProperty('--gap', `${gap}px`);
    }

    // Centre message: respawn countdown, or a prompt when standing on a different gun.
    const msg = $('centre-msg');
    let text = '';
    const me = view.players.find((p) => p.id === view.meId);
    if (hud && hud.respawnIn > 0 && m.phase === 'live') {
      text = `Respawning in ${hud.respawnIn.toFixed(1)}<small>${this.killedBy ? `Taken out by ${esc(this.killedBy)}` : 'Watch your step'}</small>`;
    } else if (hud && me?.alive && hud.primary) {
      const under = view.pickups.find((k) => k.active && k.kind === 'weapon' && k.weapon && k.weapon !== hud.primary && Math.abs(k.x - me.x) < 1 && Math.abs(k.y + 0.5 - (me.y + 0.9)) < 1.4);
      if (under?.weapon) text = `<small>${this.touch ? 'Tap Pick up' : 'Press E'} to swap for the ${esc(WEAPONS[under.weapon].name)}</small>`;
    }
    if (msg.innerHTML !== text) msg.innerHTML = text;

    // Crosshair, hit marker, damage vignette, toast.
    $('crosshair').style.transform = `translate(${cursor.x}px, ${cursor.y}px)`;
    this.hitmarkTime -= dt;
    if (this.hitmarkTime <= 0) $('hitmark').classList.remove('show');
    this.vignette = Math.max(hud && hud.hp < 30 && hud.hp > 0 ? 0.35 : 0, this.vignette - dt * 1.6);
    $('vignette').style.opacity = String(this.vignette);
    this.toastTime -= dt;
    if (this.toastTime <= 0) $('toast').classList.remove('show');

    // Damage numbers rise and fade.
    for (let i = this.nums.length - 1; i >= 0; i--) {
      const n = this.nums[i];
      n.life -= dt;
      n.y += dt * 1.6;
      if (n.life <= 0) {
        n.el.remove();
        this.nums.splice(i, 1);
        continue;
      }
      const s = renderer.worldToScreen(n.x, n.y, 0.5);
      n.el.style.left = `${s.x}px`;
      n.el.style.top = `${s.y}px`;
      n.el.style.opacity = String(Math.min(1, n.life * 3));
    }

    this.updateTags(view.players, view.meId, renderer);

    if (this.showFps) {
      this.fpsAcc.t += dt;
      this.fpsAcc.n++;
      if (this.fpsAcc.t > 0.5) {
        const el = $('fps');
        el.hidden = false;
        el.textContent = `${Math.round(this.fpsAcc.n / this.fpsAcc.t)} fps`;
        this.fpsAcc = { t: 0, n: 0 };
      }
    } else {
      $('fps').hidden = true;
    }
  }

  setNet(text: string, bad: boolean): void {
    const el = $('hud-net');
    el.textContent = text;
    el.classList.toggle('bad', bad);
  }

  private renderScore(view: GameView): void {
    const m = view.match;
    let html: string;
    if (m.mode === 'tdm') {
      html = `<span class="ember">${m.teamScores[0]}<small>${TEAM_NAMES[0]}</small></span><span class="tide">${m.teamScores[1]}<small>${TEAM_NAMES[1]}</small></span>`;
    } else {
      const sorted = [...view.players].sort((a, b) => b.score - a.score);
      const me = view.players.find((p) => p.id === view.meId);
      const leader = sorted.find((p) => p.id !== view.meId);
      const parts: string[] = [];
      if (me) parts.push(`<span>${me.score}<small>You</small></span>`);
      if (leader) parts.push(`<span>${leader.score}<small>${esc(leader.name)}</small></span>`);
      html = parts.join('');
    }
    html += `<span><small>First to</small>${m.killLimit}</span>`;
    const el = $('hud-score');
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  private updateTags(players: ViewPlayer[], meId: number, renderer: GameRenderer): void {
    const seen = new Set<number>();
    for (const p of players) {
      seen.add(p.id);
      let t = this.tags.get(p.id);
      if (!t) {
        const el = document.createElement('div');
        el.className = p.id === meId ? 'tag me' : 'tag';
        el.innerHTML = p.id === meId ? `<span></span>` : `<span></span><div class="hpb"><i></i></div>`;
        this.labels.append(el);
        t = { el, bar: el.querySelector('i') ?? el, name: '' };
        this.tags.set(p.id, t);
      }
      const label = p.id === meId ? 'You' : p.name;
      if (t.name !== label) {
        t.name = label;
        t.el.firstElementChild!.textContent = label;
      }
      const s = renderer.worldToScreen(p.x, p.y + PLAYER_H + 0.45, 0);
      const vis = p.alive && s.on;
      t.el.style.display = vis ? '' : 'none';
      if (!vis) continue;
      if (p.id !== meId) {
        t.el.style.color = playerColor(p.team, p.color);
        t.bar.style.width = `${Math.max(0, p.hp)}%`;
      }
      t.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%)`;
    }
    for (const [id, t] of this.tags) {
      if (!seen.has(id)) {
        t.el.remove();
        this.tags.delete(id);
      }
    }
  }
}

/** Scoreboard table used for Tab and the results screen. */
export function scoreTable(rows: ResultRow[], meId: number, mode: 'ffa' | 'tdm', teamScores?: [number, number]): string {
  const row = (r: ResultRow, i: number) => `
    <tr class="${r.id === meId ? 'me' : ''}">
      <td>${i + 1}</td>
      <td class="name" style="--team:${playerColor(r.team, r.color)}">${esc(r.name)}${r.bot ? '<span class="bot">bot</span>' : ''}</td>
      <td>${r.kills}</td><td>${r.deaths}</td><td>${r.assists}</td><td>${r.score}</td>
    </tr>`;
  const head = '<thead><tr><th>#</th><th>Player</th><th title="Kills">K</th><th title="Deaths">D</th><th title="Assists">A</th><th>Score</th></tr></thead>';
  if (mode === 'tdm') {
    return [0, 1]
      .map((team) => {
        const list = rows.filter((r) => r.team === team);
        return `<div class="team-total" style="--team:${TEAM_COLORS[team]}"><span>${TEAM_NAMES[team]}</span><span>${teamScores?.[team] ?? 0}</span></div>
          <table class="scores">${head}<tbody>${list.map(row).join('')}</tbody></table>`;
      })
      .join('');
  }
  return `<table class="scores">${head}<tbody>${rows.map(row).join('')}</tbody></table>`;
}

export function viewRows(view: GameView): ResultRow[] {
  return view.players
    .map((p) => ({ id: p.id, name: p.name, team: p.team, color: p.color, bot: p.bot, kills: p.kills, deaths: p.deaths, assists: p.assists, score: p.score }))
    .sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);
}
