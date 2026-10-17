import { Btn } from '../shared/constants';

/** True on phones and tablets: the primary pointer is a finger. */
export function isTouchDevice(): boolean {
  return matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches);
}

interface Stick {
  id: number | null;
  ox: number;
  oy: number;
  dx: number;
  dy: number;
  base: HTMLElement;
  knob: HTMLElement;
}

/** Stick travel in CSS pixels at full deflection. */
const RADIUS = 56;
/** Right-stick deflection (0..1) past which the gun fires. */
const FIRE_AT = 0.62;

/**
 * Floating twin-stick controls. A touch on the left half of the screen places the
 * movement stick under the thumb; a touch on the right half places the aim stick.
 * Pushing the aim stick past the outer ring fires. Buttons cover the other actions.
 */
export class TouchControls {
  readonly root: HTMLElement;
  enabled = false;
  /** Last aim direction (x right, y up). Kept after the thumb lifts so the aim holds. */
  aim = { x: 1, y: 0 };
  aimActive = false;
  private move: Stick;
  private look: Stick;
  private latched = 0;
  private disposers: (() => void)[] = [];

  constructor(private handlers: { pause: () => void; scoreboard: () => void }) {
    this.root = document.getElementById('touch')!;
    this.move = this.makeStick('move');
    this.look = this.makeStick('aim');
    const zone = this.root.querySelector<HTMLElement>('.tzone')!;
    this.on(zone, 'pointerdown', (e) => this.down(e as PointerEvent));
    this.on(window, 'pointermove', (e) => this.drag(e as PointerEvent));
    this.on(window, 'pointerup', (e) => this.up(e as PointerEvent));
    this.on(window, 'pointercancel', (e) => this.up(e as PointerEvent));
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-act]')) {
      this.on(b, 'pointerdown', (e) => {
        e.preventDefault();
        this.press(b.dataset.act!);
        b.classList.add('held');
      });
      const release = () => b.classList.remove('held');
      this.on(b, 'pointerup', release);
      this.on(b, 'pointercancel', release);
      this.on(b, 'contextmenu', (e) => e.preventDefault());
    }
  }

  show(on: boolean): void {
    this.root.hidden = !on;
    this.enabled = on;
    if (!on) this.reset();
  }

  reset(): void {
    for (const s of [this.move, this.look]) {
      s.id = null;
      s.dx = s.dy = 0;
      s.base.hidden = true;
    }
    this.aimActive = false;
    this.latched = 0;
  }

  /** Buttons and movement for one tick, in the same form as the keyboard input. */
  sample(): { b: number; mx: number } {
    if (!this.enabled) return { b: 0, mx: 0 };
    let b = this.latched;
    this.latched = 0;
    const mx = Math.abs(this.move.dx) > 0.3 ? Math.sign(this.move.dx) : 0;
    if (this.move.dy < -0.45) b |= Btn.Up;
    if (this.move.dy > 0.6) b |= Btn.Down;
    if (this.look.id !== null && Math.hypot(this.look.dx, this.look.dy) > FIRE_AT) b |= Btn.Fire;
    return { b, mx };
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  private makeStick(name: string): Stick {
    const base = document.createElement('div');
    base.className = `stick ${name}`;
    base.hidden = true;
    base.innerHTML = '<i></i>';
    this.root.append(base);
    return { id: null, ox: 0, oy: 0, dx: 0, dy: 0, base, knob: base.firstElementChild as HTMLElement };
  }

  private on(t: EventTarget, type: string, fn: (e: Event) => void) {
    t.addEventListener(type, fn, { passive: false });
    this.disposers.push(() => t.removeEventListener(type, fn));
  }

  private press(act: string): void {
    if (act === 'pause') return this.handlers.pause();
    if (act === 'board') return this.handlers.scoreboard();
    if (!this.enabled) return;
    if (act === 'grenade') this.latched |= Btn.Grenade;
    if (act === 'reload') this.latched |= Btn.Reload;
    if (act === 'swap') this.latched |= Btn.Swap;
    if (act === 'interact') this.latched |= Btn.Interact;
  }

  private down(e: PointerEvent): void {
    if (!this.enabled) return;
    e.preventDefault();
    const stick = e.clientX < innerWidth / 2 ? this.move : this.look;
    if (stick.id !== null) return;
    stick.id = e.pointerId;
    stick.ox = e.clientX;
    stick.oy = e.clientY;
    stick.dx = stick.dy = 0;
    stick.base.hidden = false;
    stick.base.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    stick.knob.style.transform = 'translate(-50%, -50%)';
  }

  private drag(e: PointerEvent): void {
    for (const s of [this.move, this.look]) {
      if (s.id !== e.pointerId) continue;
      e.preventDefault();
      let dx = (e.clientX - s.ox) / RADIUS;
      let dy = (e.clientY - s.oy) / RADIUS;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        dx /= len;
        dy /= len;
      }
      s.dx = dx;
      s.dy = dy;
      s.knob.style.transform = `translate(calc(-50% + ${dx * RADIUS}px), calc(-50% + ${dy * RADIUS}px))`;
      const mag = Math.hypot(dx, dy);
      if (s === this.look && mag > 0.2) {
        this.aim = { x: dx / mag, y: -dy / mag };
        this.aimActive = true;
      }
      s.base.classList.toggle('firing', s === this.look && mag > FIRE_AT);
    }
  }

  private up(e: PointerEvent): void {
    for (const s of [this.move, this.look]) {
      if (s.id !== e.pointerId) continue;
      s.id = null;
      s.dx = s.dy = 0;
      s.base.hidden = true;
      s.base.classList.remove('firing');
    }
  }
}
