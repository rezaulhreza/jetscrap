import { DEFAULT_SETTINGS, type MatchSettings } from '../shared/types';

export type Quality = 'low' | 'medium' | 'high';

export interface Prefs {
  name: string;
  master: number;
  effects: number;
  sensitivity: number;
  quality: Quality;
  shake: boolean;
  showFps: boolean;
  solo: MatchSettings & { team: number };
}

const KEY = 'jetscrap.prefs.v1';

function defaults(): Prefs {
  return {
    name: `Pilot ${100 + Math.floor(Math.random() * 900)}`,
    master: 0.8,
    effects: 0.9,
    sensitivity: 1,
    quality: 'high',
    shake: true,
    showFps: false,
    solo: { ...DEFAULT_SETTINGS, team: 0 },
  };
}

/** Player preferences, kept in this browser only. Storage failures fall back to defaults. */
export function loadPrefs(): Prefs {
  const base = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Prefs>;
    return { ...base, ...saved, solo: { ...base.solo, ...(saved.solo ?? {}) } };
  } catch {
    return base;
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Private mode or blocked storage: settings last for this visit only.
  }
}

/** A per-tab client id, so a reload rejoins the same slot but two tabs are two players. */
export function clientId(): string {
  try {
    let id = sessionStorage.getItem('jetscrap.cid');
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem('jetscrap.cid', id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}
