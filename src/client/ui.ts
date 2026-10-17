import { MAX_PLAYERS, TEAM_NAMES } from '../shared/constants';
import { MAPS, MAP_IDS } from '../shared/maps';
import type { MemberInfo } from '../shared/protocol';
import { DIFFICULTIES, KILL_LIMITS, TIME_LIMITS, type MatchSettings } from '../shared/types';
import { TEAM_COLORS } from './render/models';
import type { Prefs, Quality } from './settings';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const DIFF_LABEL: Record<string, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard', elite: 'Elite' };

/** Shows one menu screen and hides the rest. */
export function showScreen(name: string): void {
  for (const s of document.querySelectorAll<HTMLElement>('.screen')) s.hidden = s.dataset.screen !== name;
  const first = document.querySelector<HTMLElement>(`.screen[data-screen="${name}"] button, .screen[data-screen="${name}"] input`);
  first?.focus({ preventScroll: true });
}

function seg<T extends string | number>(label: string, options: { value: T; text: string }[], current: T, editable: boolean, onPick: (v: T) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'opt';
  row.innerHTML = `<span class="label">${esc(label)}</span>`;
  const box = document.createElement('div');
  box.className = 'seg';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', label);
  for (const o of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = o.text;
    b.setAttribute('aria-pressed', String(o.value === current));
    b.disabled = !editable;
    b.addEventListener('click', () => onPick(o.value));
    box.append(b);
  }
  row.append(box);
  return row;
}

function range(label: string, min: number, max: number, value: number, editable: boolean, onChange: (v: number) => void, fmt: (v: number) => string = String): HTMLElement {
  const row = document.createElement('div');
  row.className = 'opt';
  const id = `r-${label.replace(/\W/g, '')}-${Math.random().toString(36).slice(2, 6)}`;
  row.innerHTML = `<label class="label" for="${id}">${esc(label)}</label><div class="range-val"><input type="range" id="${id}" min="${min}" max="${max}" step="1" value="${value}" ${editable ? '' : 'disabled'}><output>${fmt(value)}</output></div>`;
  const input = row.querySelector('input')!;
  const out = row.querySelector('output')!;
  input.addEventListener('input', () => (out.textContent = fmt(Number(input.value))));
  input.addEventListener('change', () => onChange(Number(input.value)));
  return row;
}

/**
 * Match settings form, shared by the solo setup and the online lobby.
 * `team` is shown for solo team matches only.
 */
export function renderSetup(
  container: HTMLElement,
  s: MatchSettings & { team?: number },
  editable: boolean,
  onChange: (patch: Partial<MatchSettings> & { team?: number }) => void,
  opts: { solo: boolean },
): void {
  container.innerHTML = '';
  container.append(
    seg('Mode', [{ value: 'ffa', text: 'Free-for-all' }, { value: 'tdm', text: 'Team deathmatch' }], s.mode, editable, (v) => onChange({ mode: v })),
  );

  const mapRow = document.createElement('div');
  mapRow.className = 'opt';
  mapRow.innerHTML = '<span class="label">Map</span>';
  const maps = document.createElement('div');
  maps.className = 'maps';
  for (const id of MAP_IDS) {
    const m = MAPS[id];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'map-card';
    b.style.setProperty('--swatch', m.theme.accent);
    b.setAttribute('aria-pressed', String(s.map === id));
    b.disabled = !editable;
    b.innerHTML = `<b>${esc(m.name)}</b><small>${esc(m.blurb)}</small>`;
    b.addEventListener('click', () => onChange({ map: id }));
    maps.append(b);
  }
  mapRow.append(maps);
  container.append(mapRow);

  container.append(range('Bots', 0, MAX_PLAYERS - 1, s.bots, editable, (v) => onChange({ bots: v })));
  container.append(seg('Bot skill', DIFFICULTIES.map((d) => ({ value: d, text: DIFF_LABEL[d] })), s.difficulty, editable, (v) => onChange({ difficulty: v })));
  container.append(seg('Time limit', TIME_LIMITS.map((t) => ({ value: t, text: `${t / 60} min` })), s.timeLimit, editable, (v) => onChange({ timeLimit: v })));
  container.append(seg('Score to win', KILL_LIMITS.map((k) => ({ value: k, text: String(k) })), s.killLimit, editable, (v) => onChange({ killLimit: v })));
  if (opts.solo && s.mode === 'tdm') {
    container.append(seg('Your team', [0, 1].map((t) => ({ value: t, text: TEAM_NAMES[t] })), s.team ?? 0, editable, (v) => onChange({ team: v })));
  }
}

export function renderSettingsForm(container: HTMLElement, prefs: Prefs, onChange: (p: Partial<Prefs>) => void): void {
  container.innerHTML = '';
  const pct = (v: number) => `${v}%`;
  container.append(range('Master volume', 0, 100, Math.round(prefs.master * 100), true, (v) => onChange({ master: v / 100 }), pct));
  container.append(range('Effects volume', 0, 100, Math.round(prefs.effects * 100), true, (v) => onChange({ effects: v / 100 }), pct));
  container.append(range('Mouse sensitivity', 20, 300, Math.round(prefs.sensitivity * 100), true, (v) => onChange({ sensitivity: v / 100 }), (v) => `${(v / 100).toFixed(1)}×`));
  container.append(
    seg<Quality>('Graphics', [{ value: 'low', text: 'Low' }, { value: 'medium', text: 'Medium' }, { value: 'high', text: 'High' }], prefs.quality, true, (v) => {
      onChange({ quality: v });
      renderSettingsForm(container, { ...prefs, quality: v }, onChange);
    }),
  );
  container.append(
    seg('Screen shake', [{ value: 1, text: 'On' }, { value: 0, text: 'Off' }], prefs.shake ? 1 : 0, true, (v) => {
      onChange({ shake: v === 1 });
      renderSettingsForm(container, { ...prefs, shake: v === 1 }, onChange);
    }),
  );
  container.append(
    seg('Frame rate counter', [{ value: 1, text: 'Show' }, { value: 0, text: 'Hide' }], prefs.showFps ? 1 : 0, true, (v) => {
      onChange({ showFps: v === 1 });
      renderSettingsForm(container, { ...prefs, showFps: v === 1 }, onChange);
    }),
  );
  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = 'Low graphics turns off shadows and lowers resolution. Use it if the game stutters.';
  container.append(note);
}

/** Lobby player list. In team matches each column has a button to switch to it. */
export function renderMembers(container: HTMLElement, members: MemberInfo[], you: string, host: string, mode: 'ffa' | 'tdm', onTeam: (t: number) => void): void {
  const row = (m: MemberInfo) =>
    `<div class="member ${m.cid === you ? 'me' : ''}" style="--team:${mode === 'tdm' ? TEAM_COLORS[m.team] : 'var(--line)'}">
      <span class="who">${esc(m.name)}${m.cid === you ? ' (you)' : ''}</span>
      ${m.cid === host ? '<span class="badge">Host</span>' : ''}
      ${m.connected ? '' : '<span class="badge">Reconnecting</span>'}
    </div>`;
  if (mode === 'ffa') {
    container.innerHTML = members.map(row).join('');
    return;
  }
  container.innerHTML = '';
  for (const t of [0, 1]) {
    const col = document.createElement('div');
    col.className = 'team-col';
    const mine = members.find((m) => m.cid === you)?.team === t;
    col.innerHTML = `<h4 style="color:${TEAM_COLORS[t]}">${TEAM_NAMES[t]}${mine ? '' : `<button class="plate small quiet" type="button">Join ${TEAM_NAMES[t]}</button>`}</h4>${members.filter((m) => m.team === t).map(row).join('') || '<p class="hint">Nobody yet. Bots fill empty places.</p>'}`;
    col.querySelector('button')?.addEventListener('click', () => onTeam(t));
    container.append(col);
  }
}
