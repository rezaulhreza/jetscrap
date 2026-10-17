import { Btn } from '../shared/constants';

/**
 * Keyboard and mouse state for the local player. Uses pointer lock when the browser
 * allows it, with a virtual cursor moved by mouse deltas times the sensitivity
 * setting. Without pointer lock the real cursor position is used.
 */
export class Input {
  /** Cursor position in CSS pixels. */
  cx = innerWidth / 2;
  cy = innerHeight / 2;
  sensitivity = 1;
  enabled = false;
  private held = new Set<string>();
  /** Buttons pressed since the last sample, so short taps between ticks still count. */
  private latched = 0;
  private mouseFire = false;
  private onPause: () => void;
  private onBoard: (show: boolean) => void;
  private disposers: (() => void)[] = [];

  constructor(private canvas: HTMLCanvasElement, handlers: { pause: () => void; scoreboard: (show: boolean) => void }) {
    this.onPause = handlers.pause;
    this.onBoard = handlers.scoreboard;
    this.listen(window, 'keydown', (e) => this.key(e as KeyboardEvent, true));
    this.listen(window, 'keyup', (e) => this.key(e as KeyboardEvent, false));
    this.listen(window, 'blur', () => this.release());
    this.listen(canvas, 'mousedown', (e) => this.mouse(e as MouseEvent, true));
    this.listen(window, 'mouseup', (e) => this.mouse(e as MouseEvent, false));
    this.listen(window, 'mousemove', (e) => this.move(e as MouseEvent));
    this.listen(canvas, 'contextmenu', (e) => e.preventDefault());
    this.listen(canvas, 'wheel', (e) => {
      if (this.enabled && Math.abs((e as WheelEvent).deltaY) > 2) this.latched |= Btn.Swap;
    }, { passive: true });
    this.listen(document, 'pointerlockchange', () => {
      // Losing the lock with Escape means the player wants the pause menu.
      if (!this.locked && this.enabled) this.onPause();
    });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  lock(): void {
    try {
      const r = this.canvas.requestPointerLock() as unknown;
      if (r instanceof Promise) r.catch(() => undefined);
    } catch {
      // Pointer lock is optional; the real cursor works too.
    }
  }

  unlock(): void {
    if (this.locked) document.exitPointerLock();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.release();
  }

  release(): void {
    this.held.clear();
    this.mouseFire = false;
    this.latched = 0;
  }

  /** Reads buttons and horizontal movement for one tick. */
  sample(): { b: number; mx: number } {
    if (!this.enabled) return { b: 0, mx: 0 };
    const h = this.held;
    let b = this.latched;
    this.latched = 0;
    if (h.has('KeyW') || h.has('Space') || h.has('ArrowUp')) b |= Btn.Up;
    if (h.has('KeyS') || h.has('ArrowDown')) b |= Btn.Down;
    if (this.mouseFire) b |= Btn.Fire;
    const left = h.has('KeyA') || h.has('ArrowLeft');
    const right = h.has('KeyD') || h.has('ArrowRight');
    return { b, mx: (right ? 1 : 0) - (left ? 1 : 0) };
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.unlock();
  }

  private listen(t: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions) {
    t.addEventListener(type, fn, opts);
    this.disposers.push(() => t.removeEventListener(type, fn, opts));
  }

  private key(e: KeyboardEvent, down: boolean) {
    if (!this.enabled) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    if (e.code === 'Tab') {
      e.preventDefault();
      this.onBoard(down);
      return;
    }
    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (down && !this.locked) this.onPause();
      return;
    }
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (down) {
      if (e.repeat) return;
      this.held.add(e.code);
      if (e.code === 'KeyR') this.latched |= Btn.Reload;
      if (e.code === 'KeyQ') this.latched |= Btn.Swap;
      if (e.code === 'KeyE') this.latched |= Btn.Interact;
      if (e.code === 'KeyG') this.latched |= Btn.Grenade;
      if (e.code === 'KeyW' || e.code === 'Space' || e.code === 'ArrowUp') this.latched |= Btn.Up;
    } else {
      this.held.delete(e.code);
    }
  }

  private mouse(e: MouseEvent, down: boolean) {
    if (!this.enabled) return;
    if (down && !this.locked) this.lock();
    if (e.button === 0) {
      this.mouseFire = down;
      if (down) this.latched |= Btn.Fire;
    }
    if (e.button === 2 && down) this.latched |= Btn.Grenade;
  }

  private move(e: MouseEvent) {
    if (this.locked) {
      this.cx = Math.max(0, Math.min(innerWidth, this.cx + e.movementX * this.sensitivity));
      this.cy = Math.max(0, Math.min(innerHeight, this.cy + e.movementY * this.sensitivity));
    } else {
      this.cx = e.clientX;
      this.cy = e.clientY;
    }
  }
}
