import '@fontsource/saira-condensed/latin-600.css';
import '@fontsource/saira-condensed/latin-700.css';
import '@fontsource/saira-condensed/latin-800.css';
import '@fontsource/saira/latin-400.css';
import '@fontsource/saira/latin-600.css';
import './style.css';

import { BOT_NAMES } from '../shared/bots';
import { TEAM_NAMES } from '../shared/constants';
import { MAP_IDS, getMap } from '../shared/maps';
import { ROOM_CODE_RE, randomRoomCode } from '../shared/protocol';
import type { GameEvent, MatchSettings } from '../shared/types';
import { Sound } from './audio';
import { Hud, scoreTable, viewRows } from './hud';
import { Input } from './input';
import { NetClient, type NetStatus } from './net';
import { GameRenderer } from './render/renderer';
import { LocalSession, type Session } from './session';
import { TouchControls, isTouchDevice } from './touch';
import { clientId, loadPrefs, savePrefs, type Prefs } from './settings';
import { $, renderMembers, renderSettingsForm, renderSetup, showScreen } from './ui';

type Mode = 'menu' | 'solo' | 'online';

class App {
  private prefs: Prefs = loadPrefs();
  private renderer: GameRenderer;
  private input: Input;
  private touch: TouchControls;
  /** Phones and tablets use on-screen sticks instead of the mouse. */
  private touchMode = isTouchDevice();
  private portrait = matchMedia('(orientation: portrait)');
  private sound = new Sound();
  private hud = new Hud();
  session: Session | null = null;
  private attract: LocalSession | null = null;
  private net: NetClient | null = null;
  private mode: Mode = 'menu';
  private paused = false;
  private resultsShown = false;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFrame = performance.now();
  private lastCountdown = 0;
  private backTarget = 'main';
  private boardOpen = false;

  constructor() {
    const canvas = $<HTMLCanvasElement>('scene');
    this.renderer = new GameRenderer(canvas);
    this.renderer.setQuality(this.prefs.quality);
    this.input = new Input(canvas, {
      pause: () => this.openPause(),
      scoreboard: (show) => this.toggleBoard(show),
    });
    this.touch = new TouchControls({
      pause: () => this.openPause(),
      scoreboard: () => this.toggleBoard(!this.boardOpen),
    });
    this.setTouchMode(this.touchMode);
    // A hybrid device switches to touch controls the first time a finger is used.
    addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && !this.touchMode) this.setTouchMode(true);
      // Fullscreen and the landscape lock need a user gesture; retry on taps during a match.
      if (this.touchMode && this.session && !document.fullscreenElement) this.goLandscape();
    });
    this.portrait.addEventListener('change', () => this.applyControls());
    this.applyPrefs();
    this.bindMenus();
    this.startAttract();

    // Audio can only start after a user gesture.
    const unlock = () => this.sound.unlock();
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);

    const room = new URLSearchParams(location.search).get('room')?.toUpperCase();
    if (room && ROOM_CODE_RE.test(room)) {
      $<HTMLInputElement>('join-code').value = room;
      showScreen('online');
      $('online-status').textContent = 'You were invited to a room. Check your name, then press Join room.';
    } else {
      showScreen('main');
    }
    // Dev builds expose the app for automated browser checks.
    if (import.meta.env.DEV) (window as unknown as { __jetscrap: App }).__jetscrap = this;
    $('boot').hidden = true;
    $('menus').hidden = false;
    requestAnimationFrame((t) => this.loop(t));
  }

  private setTouchMode(on: boolean): void {
    this.touchMode = on;
    document.body.classList.toggle('touch', on);
    this.hud.touch = on;
    this.applyControls();
  }

  /** Fullscreen plus a landscape lock where the browser supports it (Android). iOS ignores both. */
  private goLandscape(): void {
    const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    document.documentElement
      .requestFullscreen?.()
      .then(() => orientation.lock?.('landscape'))
      .catch(() => undefined);
  }

  /** True while a touch device is held upright during a match: the rotate screen covers the game. */
  private get rotateBlocked(): boolean {
    return this.touchMode && this.portrait.matches && !!this.session;
  }

  /** Enables controls only during active play, and holds a solo match while the device is upright. */
  private applyControls(): void {
    if (!this.session) return;
    const blocked = this.rotateBlocked;
    if (this.session instanceof LocalSession) this.session.paused = this.paused || blocked;
    this.setControls(!blocked && !this.paused && !this.resultsShown);
  }

  /** Turns gameplay input on or off for both the mouse/keyboard and the touch sticks. */
  private setControls(on: boolean): void {
    this.input.setEnabled(on);
    this.touch.show(on && this.touchMode);
    if (on && !this.touchMode) this.input.lock();
    if (!on) this.input.unlock();
  }

  // ------------------------------------------------------------------ menus

  private bindMenus(): void {
    // The name appears on the main and online screens; both edit the same preference.
    const nameInputs = [...document.querySelectorAll<HTMLInputElement>('.name-input')];
    for (const input of nameInputs) {
      input.value = this.prefs.name;
      input.addEventListener('input', () => {
        const v = input.value.trim().slice(0, 16);
        if (v) this.prefs.name = v;
        for (const other of nameInputs) if (other !== input) other.value = input.value;
        savePrefs(this.prefs);
      });
      input.addEventListener('change', () => {
        for (const i of nameInputs) i.value = this.prefs.name;
      });
    }

    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-go]')) {
      b.addEventListener('click', () => this.go(b.dataset.go!));
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-back]')) {
      b.addEventListener('click', () => {
        if (this.backTarget === 'pause') {
          $('menus').hidden = true;
          $('pause').hidden = false;
        } else {
          showScreen(this.backTarget);
        }
      });
    }
    document.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) this.sound.click();
    });

    $('solo-start').addEventListener('click', () => this.startSolo());
    $('create-room').addEventListener('click', () => void this.createRoom());
    $('join-form').addEventListener('submit', (e) => {
      e.preventDefault();
      void this.joinRoom($<HTMLInputElement>('join-code').value);
    });
    $('copy-link').addEventListener('click', () => this.copyInvite());
    $('lobby-start').addEventListener('click', () => this.net?.send({ t: 'start' }));
    $('lobby-leave').addEventListener('click', () => this.leaveRoom('Left the room.'));

    $('resume').addEventListener('click', () => this.resume());
    $('pause-settings').addEventListener('click', () => this.openFromPause('settings'));
    $('pause-controls').addEventListener('click', () => this.openFromPause('controls'));
    $('quit').addEventListener('click', () => this.quitMatch());

    $('rematch').addEventListener('click', () => this.rematch());
    $('to-lobby').addEventListener('click', () => this.net?.send({ t: 'lobby' }));
    $('results-quit').addEventListener('click', () => this.quitMatch());
  }

  private go(screen: string): void {
    this.backTarget = 'main';
    if (screen === 'solo') this.renderSolo();
    if (screen === 'settings') this.renderSettings();
    if (screen === 'online') $('online-status').textContent = '';
    showScreen(screen);
  }

  private renderSolo(): void {
    renderSetup($('solo-setup'), this.prefs.solo, true, (patch) => {
      this.prefs.solo = { ...this.prefs.solo, ...patch };
      savePrefs(this.prefs);
      this.renderSolo();
    }, { solo: true });
  }

  private renderSettings(): void {
    renderSettingsForm($('settings-form'), this.prefs, (patch) => {
      Object.assign(this.prefs, patch);
      savePrefs(this.prefs);
      this.applyPrefs();
    });
  }

  private applyPrefs(): void {
    this.sound.setVolumes(this.prefs.master, this.prefs.effects);
    this.input.sensitivity = this.prefs.sensitivity;
    this.renderer.setQuality(this.prefs.quality);
    this.hud.showFps = this.prefs.showFps;
  }

  // ------------------------------------------------------------------ attract mode

  /** A bots-only match on a random map plays behind the menus. */
  private startAttract(): void {
    this.attract?.dispose();
    const map = MAP_IDS[Math.floor(Math.random() * MAP_IDS.length)];
    const settings: MatchSettings = { mode: Math.random() < 0.5 ? 'ffa' : 'tdm', map, timeLimit: 600, killLimit: 50, bots: 7, difficulty: 'hard' };
    this.attract = new LocalSession(settings, null, 0, BOT_NAMES);
    this.renderer.setMap(getMap(map));
  }

  private stopAttract(): void {
    this.attract?.dispose();
    this.attract = null;
  }

  // ------------------------------------------------------------------ solo

  private startSolo(): void {
    const s = this.prefs.solo;
    const settings: MatchSettings = { mode: s.mode, map: s.map, timeLimit: s.timeLimit, killLimit: s.killLimit, bots: s.bots, difficulty: s.difficulty };
    this.stopAttract();
    this.session?.dispose();
    this.session = new LocalSession(settings, this.prefs.name, s.team, BOT_NAMES);
    this.mode = 'solo';
    this.enterMatch(settings);
  }

  // ------------------------------------------------------------------ online

  private netHandlers() {
    return {
      room: () => this.onRoom(),
      match: () => this.onNetMatch(),
      end: () => this.scheduleResults(),
      notice: (text: string) => {
        if (this.session) this.hud.toast(text);
        else $('lobby-status').textContent = text;
      },
      status: (s: NetStatus, detail?: string) => this.onNetStatus(s, detail),
    };
  }

  private async createRoom(): Promise<void> {
    const status = $('online-status');
    status.classList.remove('error');
    status.textContent = 'Creating a room…';
    for (let attempt = 0; attempt < 3; attempt++) {
      const net = new NetClient(randomRoomCode(), this.prefs.name, clientId(), this.netHandlers());
      this.net = net;
      try {
        await net.connect(true);
        return;
      } catch (err) {
        net.leave();
        this.net = null;
        const msg = (err as Error).message;
        if (!msg.includes('in use')) {
          status.classList.add('error');
          status.textContent = msg;
          return;
        }
      }
    }
  }

  private async joinRoom(raw: string): Promise<void> {
    const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const status = $('online-status');
    status.classList.remove('error');
    if (!ROOM_CODE_RE.test(code)) {
      status.classList.add('error');
      status.textContent = 'Room codes are five letters or digits, for example K7PQX.';
      return;
    }
    status.textContent = `Joining ${code}…`;
    this.net?.leave();
    const net = new NetClient(code, this.prefs.name, clientId(), this.netHandlers());
    this.net = net;
    try {
      await net.connect(false);
    } catch (err) {
      net.leave();
      this.net = null;
      status.classList.add('error');
      status.textContent = (err as Error).message;
    }
  }

  private onRoom(): void {
    const net = this.net;
    const room = net?.room;
    if (!net || !room) return;
    if (room.phase === 'lobby' && this.mode === 'online' && this.session) {
      // The host went back to the lobby.
      this.exitMatch();
    }
    if (this.mode !== 'online' || !this.session) {
      if (!this.session) {
        this.renderLobby();
        if (document.querySelector<HTMLElement>('.screen[data-screen="lobby"]')!.hidden) showScreen('lobby');
      }
    }
    if (this.resultsShown) this.updateResultButtons();
  }

  private renderLobby(): void {
    const net = this.net;
    const room = net?.room;
    if (!net || !room) return;
    $('lobby-code').textContent = room.code;
    const host = net.isHost;
    renderMembers($('lobby-teams'), room.members, room.you, room.host, room.settings.mode, (team) => net.send({ t: 'team', team }));
    renderSetup($('lobby-setup'), room.settings, host, (patch) => net.send({ t: 'settings', s: patch }), { solo: false });
    const start = $<HTMLButtonElement>('lobby-start');
    start.hidden = !host;
    const status = $('lobby-status');
    status.classList.remove('error');
    if (room.phase !== 'lobby') status.textContent = 'A match is running. You will join it shortly.';
    else status.textContent = host ? 'Share the code, set up the match, then press Start match.' : 'Waiting for the host to start the match.';
  }

  private copyInvite(): void {
    const code = this.net?.room?.code;
    if (!code) return;
    const url = `${location.origin}/?room=${code}`;
    navigator.clipboard?.writeText(url).then(
      () => ($('lobby-status').textContent = 'Invite link copied. Send it to your friends.'),
      () => ($('lobby-status').textContent = `Copy this link: ${url}`),
    );
  }

  private onNetMatch(): void {
    const s = this.net?.session;
    if (!s) return;
    this.stopAttract();
    this.session = s;
    this.mode = 'online';
    this.enterMatch(s.settings);
  }

  private onNetStatus(s: NetStatus, detail?: string): void {
    if (s === 'reconnecting') {
      this.hud.setNet(detail ?? 'Reconnecting…', true);
      if (!this.session) $('lobby-status').textContent = detail ?? 'Reconnecting…';
    } else if (s === 'open') {
      this.hud.setNet('', false);
    } else if (s === 'closed' && this.net) {
      this.leaveRoom(detail ?? 'Disconnected from the room.', true);
    }
  }

  private leaveRoom(message: string, isError = false): void {
    this.net?.leave();
    this.net = null;
    if (this.session && this.mode === 'online') this.exitMatch();
    this.session = null;
    this.mode = 'menu';
    showScreen('online');
    const status = $('online-status');
    status.textContent = message;
    status.classList.toggle('error', isError);
  }

  // ------------------------------------------------------------------ match flow

  private enterMatch(settings: MatchSettings): void {
    this.renderer.setMap(getMap(settings.map));
    this.hud.clear();
    this.hud.show(true);
    $('menus').hidden = true;
    $('results').hidden = true;
    $('pause').hidden = true;
    this.paused = false;
    this.resultsShown = false;
    if (this.endTimer) clearTimeout(this.endTimer);
    document.body.classList.add('playing');
    this.input.cx = innerWidth / 2;
    this.input.cy = innerHeight / 2;
    this.touch.aim = { x: 1, y: 0 };
    this.applyControls();
    if (this.touchMode) this.goLandscape();
    this.lastCountdown = 0;
  }

  /** Leaves the match view and returns to the menus with the attract match. */
  private exitMatch(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.setControls(false);
    this.sound.setJet(false);
    document.body.classList.remove('playing');
    this.hud.show(false);
    $('results').hidden = true;
    $('pause').hidden = true;
    $('scoreboard').hidden = true;
    $('menus').hidden = false;
    if (this.mode === 'solo') this.session?.dispose();
    this.session = null;
    this.paused = false;
    this.resultsShown = false;
    this.startAttract();
    if (this.mode === 'online' && this.net) {
      this.renderLobby();
      showScreen('lobby');
    } else {
      this.mode = 'menu';
      showScreen('main');
    }
  }

  private quitMatch(): void {
    if (this.mode === 'online') {
      this.leaveRoom('You left the match.');
      return;
    }
    this.exitMatch();
  }

  private openPause(): void {
    if (!this.session || this.resultsShown || this.paused) return;
    this.paused = true;
    this.setControls(false);
    this.sound.setJet(false);
    if (this.session instanceof LocalSession) this.session.paused = true;
    $('pause-note').textContent = this.mode === 'online' ? 'The match keeps running for everyone else.' : '';
    $('pause').hidden = false;
    $('resume').focus();
  }

  private resume(): void {
    if (!this.session) return;
    $('pause').hidden = true;
    $('menus').hidden = true;
    this.paused = false;
    this.applyControls();
  }

  private openFromPause(screen: 'settings' | 'controls'): void {
    this.backTarget = 'pause';
    if (screen === 'settings') this.renderSettings();
    $('pause').hidden = true;
    $('menus').hidden = false;
    showScreen(screen);
  }

  private toggleBoard(show: boolean): void {
    this.boardOpen = show && !!this.session;
    $('scoreboard').hidden = !this.boardOpen;
  }

  private scheduleResults(): void {
    if (this.resultsShown || this.endTimer) return;
    // A short beat to watch the final kill before the table appears.
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      this.showResults();
    }, 1600);
  }

  private showResults(): void {
    const session = this.session;
    if (!session) return;
    this.resultsShown = true;
    this.setControls(false);
    this.sound.setJet(false);
    $('pause').hidden = true;
    $('scoreboard').hidden = true;
    const view = session.view;
    const rows = session.results().length ? session.results() : viewRows(view);
    const m = view.match;
    const me = view.players.find((p) => p.id === view.meId);
    let title: string;
    if (m.mode === 'tdm') {
      title = m.winner === -1 ? 'Draw' : `${TEAM_NAMES[m.winner]} win`;
      if (me && m.winner !== -1) title += me.team === m.winner ? '. Your team won' : '. Your team lost';
    } else {
      const winner = rows.find((r) => r.id === m.winner);
      title = !winner ? 'Draw' : winner.id === view.meId ? 'You win' : `${winner.name} wins`;
    }
    $('results-title').textContent = title;
    const mine = rows.find((r) => r.id === view.meId);
    const n = (v: number, word: string) => `${v} ${word}${v === 1 ? '' : 's'}`;
    $('results-sub').textContent = mine ? `You finished with ${n(mine.kills, 'kill')}, ${n(mine.deaths, 'death')} and ${n(mine.assists, 'assist')}.` : '';
    $('results-body').innerHTML = scoreTable(rows, view.meId, m.mode, m.teamScores);
    $('results').hidden = false;
    this.updateResultButtons();
  }

  private updateResultButtons(): void {
    const online = this.mode === 'online';
    const host = !!this.net?.isHost;
    const rematch = $<HTMLButtonElement>('rematch');
    rematch.disabled = online && !host;
    rematch.textContent = online && !host ? 'Waiting for host' : 'Rematch';
    $('to-lobby').hidden = !(online && host);
    $('results-quit').textContent = online ? 'Leave room' : 'Main menu';
  }

  private rematch(): void {
    if (this.mode === 'online') {
      this.net?.send({ t: 'start' });
      return;
    }
    this.session?.dispose();
    this.session = null;
    this.startSolo();
  }

  // ------------------------------------------------------------------ frame loop

  private loop(now: number): void {
    requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    try {
      this.frame(dt);
    } catch (err) {
      console.error(err);
    }
  }

  private frame(dt: number): void {
    const session = this.session ?? this.attract;
    if (!session) return;
    const playing = session === this.session;
    session.update(dt, () => {
      const s = this.input.sample();
      const t = this.touch.sample();
      const sh = session.shoulder();
      if (this.touchMode && sh && playing) {
        // The aim stick sets a direction; place the virtual cursor along it so the
        // crosshair, camera look-ahead and aim all work as they do with a mouse.
        const p = this.renderer.worldToScreen(sh.x, sh.y);
        const r = Math.min(innerWidth, innerHeight) * 0.3;
        this.input.cx = p.x + this.touch.aim.x * r;
        this.input.cy = p.y - this.touch.aim.y * r;
      }
      const w = this.renderer.screenToWorld(this.input.cx, this.input.cy);
      return { b: s.b | t.b, mx: t.mx || s.mx, aim: sh ? Math.atan2(w.y - sh.y, w.x - sh.x) : 0 };
    });
    const view = session.view;
    const events = session.drainEvents();
    this.renderer.handleEvents(view, events);
    if (playing) {
      this.playSounds(view, events);
      this.hud.events(view, events);
    }
    this.renderer.frame(view, dt, {
      followId: playing ? view.meId : undefined,
      cursor: playing && !this.paused && !this.resultsShown ? { x: this.input.cx, y: this.input.cy } : undefined,
      shake: this.prefs.shake,
    });
    if (!playing) return;

    this.hud.update(view, dt, this.renderer, { x: this.input.cx, y: this.input.cy });
    if (this.boardOpen) {
      $('board-body').innerHTML = scoreTable(viewRows(view), view.meId, view.match.mode, view.match.teamScores);
    }
    if (this.mode === 'online' && this.net) {
      const rtt = this.net.rtt;
      if (rtt !== null && !$('hud-net').classList.contains('bad')) this.hud.setNet(`${Math.round(rtt)} ms`, rtt > 200);
    }
    if (view.match.phase === 'ended' && this.mode === 'solo') this.scheduleResults();
  }

  private playSounds(view: { meId: number; match: { phase: string; timeLeft: number }; players: { id: number; x: number; y: number; jetting: boolean; alive: boolean }[] }, events: GameEvent[]): void {
    const me = view.players.find((p) => p.id === view.meId);
    if (me) {
      this.sound.listenerX = me.x;
      this.sound.listenerY = me.y;
    }
    this.sound.setJet(!!me?.alive && !!me.jetting && !this.paused);
    for (const e of events) {
      switch (e.k) {
        case 'shot':
          this.sound.shot(e.w, e.x, e.y, e.p === view.meId);
          break;
        case 'boom':
          this.sound.boom(e.x, e.y);
          break;
        case 'impact':
          this.sound.impact(e.x, e.y, e.flesh);
          break;
        case 'hit':
          if (e.by === view.meId && e.p !== view.meId) this.sound.hitMarker(e.head);
          if (e.p === view.meId) this.sound.hurt();
          break;
        case 'kill':
          if (e.by === view.meId && e.p !== view.meId) this.sound.killConfirm();
          break;
        case 'pickup':
          if (e.p === view.meId) this.sound.pickup(e.kind);
          break;
        case 'reload':
          if (e.p === view.meId) this.sound.reload();
          break;
        case 'phase':
          if (e.phase === 'live') this.sound.beep(true);
          break;
      }
    }
    if (view.match.phase === 'countdown') {
      const n = Math.ceil(view.match.timeLeft);
      if (n !== this.lastCountdown && n > 0) {
        this.lastCountdown = n;
        this.sound.beep(false);
      }
    }
  }
}

function boot(): void {
  const text = $('boot-text');
  try {
    const probe = document.createElement('canvas');
    if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) {
      text.textContent = 'Jetscrap needs WebGL. Turn on hardware acceleration in your browser settings, or try another browser.';
      return;
    }
    new App();
  } catch (err) {
    console.error(err);
    text.textContent = `Jetscrap could not start: ${(err as Error).message}. Reload the page to try again.`;
  }
}

boot();
