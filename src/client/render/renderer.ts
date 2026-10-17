import * as THREE from 'three';
import type { MapDef } from '../../shared/maps';
import type { GameEvent, PickupState } from '../../shared/types';
import type { Quality } from '../settings';
import type { GameView, ViewPlayer } from '../session';
import { Effects } from './effects';
import { buildEnvironment, type Environment } from './environment';
import { CharacterModel, GRENADE_MODEL, ROCKET_MODEL, makePickup, playerColor } from './models';

export const PICKUP_COLORS: Record<string, string> = {
  health: '#ff5a4f', armor: '#7db1ff', ammo: '#f2b530', grenades: '#9ccf6a', overdrive: '#ff4b3a', haste: '#ffd23a', weapon: '#e9e4d8',
};

const FOV = 38;
/** World units visible vertically at the play plane. */
const VIEW_HEIGHT = 24;

export interface FrameOptions {
  /** Cursor in CSS pixels, for camera look-ahead. */
  cursor?: { x: number; y: number };
  /** Player to follow; falls back to a slow pan across the map. */
  followId?: number;
  shake: boolean;
}

/** Owns the Three.js scene and turns GameView snapshots and events into visuals. */
export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 900);
  readonly effects = new Effects();
  map: MapDef | null = null;
  private env: Environment | null = null;
  private chars = new Map<number, CharacterModel>();
  private pickups = new Map<number, { obj: THREE.Group; key: string; pad: THREE.Mesh | null }>();
  private heavy = new Map<number, { obj: THREE.Group; kind: string }>();
  private padGeo = new THREE.CylinderGeometry(0.55, 0.65, 0.08, 20);
  private padMat = new THREE.MeshStandardMaterial({ color: '#30363d', emissive: '#f2b530', emissiveIntensity: 0.3, roughness: 0.5 });
  private padMatOff = new THREE.MeshStandardMaterial({ color: '#30363d', roughness: 0.5 });
  private cam = { x: 0, y: 0, dist: 38 };
  private shake = 0;
  private time = 0;
  private quality: Quality = 'high';
  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private tmp = new THREE.Vector3();
  private onResize = () => this.resize();
  private panT = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.add(this.effects.group);
    addEventListener('resize', this.onResize);
    this.resize();
  }

  setQuality(q: Quality): void {
    this.quality = q;
    const dpr = devicePixelRatio || 1;
    this.renderer.setPixelRatio(q === 'low' ? Math.min(dpr, 1) * 0.75 : q === 'medium' ? Math.min(dpr, 1.25) : Math.min(dpr, 2));
    const shadows = q !== 'low';
    if (this.renderer.shadowMap.enabled !== shadows) {
      this.renderer.shadowMap.enabled = shadows;
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m) m.needsUpdate = true;
      });
    }
    if (this.env) {
      const size = q === 'high' ? 2048 : 1024;
      if (this.env.sun.shadow.mapSize.x !== size) {
        this.env.sun.shadow.mapSize.set(size, size);
        this.env.sun.shadow.map?.dispose();
        this.env.sun.shadow.map = null;
      }
    }
    this.effects.setQuality(q);
    this.resize();
  }

  setMap(map: MapDef): void {
    if (this.map?.id === map.id && this.env) {
      this.clearEntities();
      this.effects.setMap(map);
      return;
    }
    this.env?.dispose();
    this.clearEntities();
    this.map = map;
    this.env = buildEnvironment(map, this.scene);
    this.effects.setMap(map);
    this.cam.x = map.width / 2;
    this.cam.y = map.height / 2;
    this.setQuality(this.quality);
  }

  private clearEntities(): void {
    for (const c of this.chars.values()) {
      this.scene.remove(c.root);
      c.dispose();
    }
    this.chars.clear();
    for (const p of this.pickups.values()) {
      this.scene.remove(p.obj);
      if (p.pad) this.scene.remove(p.pad);
    }
    this.pickups.clear();
    for (const h of this.heavy.values()) this.scene.remove(h.obj);
    this.heavy.clear();
  }

  resize(): void {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    // Short screens (phones in landscape) zoom in so characters stay readable.
    const viewHeight = h < 500 ? 19 : VIEW_HEIGHT;
    // Keep a playable view on narrow screens: at least 30 units across.
    this.cam.dist = Math.max(viewHeight / 2 / tan, 15 / (tan * this.camera.aspect));
    this.camera.updateProjectionMatrix();
  }

  /** Converts a CSS pixel position to a point on the play plane. */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const ndc = new THREE.Vector2((sx / innerWidth) * 2 - 1, -(sy / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.plane, this.tmp);
    return hit ? { x: hit.x, y: hit.y } : { x: this.cam.x, y: this.cam.y };
  }

  worldToScreen(x: number, y: number, z = 0): { x: number; y: number; on: boolean } {
    const v = this.tmp.set(x, y, z).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, on: v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 };
  }

  addShake(amount: number): void {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  /** Applies presentation events: muzzle flashes, tracers, impacts, explosions, deaths. */
  handleEvents(view: GameView, events: GameEvent[]): void {
    const byId = new Map(view.players.map((p) => [p.id, p]));
    const me = byId.get(view.meId);
    for (const e of events) {
      switch (e.k) {
        case 'shot': {
          this.chars.get(e.p)?.fire(e.w);
          this.effects.muzzle(e.x, e.y, e.a, e.w);
          if (e.p === view.meId) this.addShake(e.w === 'rocket' || e.w === 'shotgun' ? 0.18 : e.w === 'sniper' ? 0.22 : 0.03);
          break;
        }
        case 'bullet':
          this.effects.bullet(e.id, e.p, e.w, e.x, e.y, e.vx, e.vy, e.life, e.id < 0);
          break;
        case 'impact': {
          const color = '#ff6a4d';
          this.effects.impact(e.id, e.x, e.y, e.flesh, color);
          if (e.flesh) this.effects.impactNear(view.meId, e.x, e.y);
          break;
        }
        case 'hit':
          this.chars.get(e.p)?.onHurt();
          if (e.p === view.meId) this.addShake(Math.min(0.35, e.d * 0.008));
          break;
        case 'kill': {
          const v = byId.get(e.p);
          if (v) this.effects.deathBurst(v.x, v.y, playerColor(v.team, v.color));
          break;
        }
        case 'boom': {
          this.effects.explosion(e.x, e.y, e.r);
          const d = me ? Math.hypot(me.x - e.x, me.y - e.y) : Math.hypot(this.cam.x - e.x, this.cam.y - e.y);
          this.addShake(Math.max(0, 0.9 - d * 0.04));
          break;
        }
        case 'pickup': {
          const v = byId.get(e.p);
          if (v) this.effects.pickupFlash(v.x, v.y, PICKUP_COLORS[e.kind] ?? '#fff');
          break;
        }
        case 'spawn': {
          const v = byId.get(e.p);
          this.effects.spawnRing(e.x, e.y, v ? playerColor(v.team, v.color) : '#fff');
          break;
        }
      }
    }
  }

  frame(view: GameView, dt: number, opts: FrameOptions): void {
    if (!this.map) return;
    this.time += dt;
    const time = this.time;

    // Characters.
    const seen = new Set<number>();
    const targets: { x: number; y: number }[] = [];
    for (const p of view.players) {
      seen.add(p.id);
      let c = this.chars.get(p.id);
      if (!c) {
        c = new CharacterModel(playerColor(p.team, p.color));
        this.chars.set(p.id, c);
        this.scene.add(c.root);
      }
      c.update(p, dt, time);
      if (p.alive && p.jetting && Math.random() < 0.8) {
        const facing = Math.cos(p.aim) >= 0 ? 1 : -1;
        this.effects.jetPuff(p.x - facing * 0.36, p.y + 0.7);
      }
      if (p.alive && p.haste && Math.random() < 0.4) this.effects.hazardSpark(p.x, p.y + 0.4 + Math.random(), '#ffd23a');
      if (p.alive && p.id !== view.meId) targets.push({ x: p.x, y: p.y });
    }
    for (const [id, c] of this.chars) {
      if (!seen.has(id)) {
        this.scene.remove(c.root);
        c.dispose();
        this.chars.delete(id);
      }
    }
    this.effects.targets = targets;

    this.syncPickups(view.pickups, time);
    this.syncHeavy(view, time);
    this.env?.update(dt, time, (x, y, hex) => this.effects.hazardSpark(x, y, hex));
    this.effects.update(dt);
    this.updateCamera(view, dt, opts);
    this.renderer.render(this.scene, this.camera);
  }

  private syncPickups(list: readonly PickupState[], time: number): void {
    const seen = new Set<number>();
    for (const k of list) {
      seen.add(k.id);
      const key = `${k.kind}:${k.weapon ?? ''}`;
      let entry = this.pickups.get(k.id);
      if (entry && entry.key !== key) {
        this.scene.remove(entry.obj);
        entry.obj = makePickup(k.kind, k.weapon);
        entry.key = key;
        this.scene.add(entry.obj);
      }
      if (!entry) {
        const obj = makePickup(k.kind, k.weapon);
        let pad: THREE.Mesh | null = null;
        if (!k.dropped) {
          pad = new THREE.Mesh(this.padGeo, this.padMat);
          pad.position.set(k.x, k.y + 0.04, 0);
          pad.receiveShadow = true;
          this.scene.add(pad);
        }
        entry = { obj, key, pad };
        this.pickups.set(k.id, entry);
        this.scene.add(obj);
      }
      entry.obj.visible = k.active;
      if (entry.pad) entry.pad.material = k.active ? this.padMat : this.padMatOff;
      const bob = Math.sin(time * 2.4 + k.id) * 0.12;
      entry.obj.position.set(k.x, k.y + (k.dropped ? 0.35 : 0.75) + (k.dropped ? 0 : bob), 0.1);
      entry.obj.rotation.y = k.kind === 'weapon' ? Math.sin(time * 1.3 + k.id) * 0.5 : time * 1.6 + k.id;
    }
    for (const [id, e] of this.pickups) {
      if (!seen.has(id)) {
        this.scene.remove(e.obj);
        if (e.pad) this.scene.remove(e.pad);
        this.pickups.delete(id);
      }
    }
  }

  private syncHeavy(view: GameView, time: number): void {
    const seen = new Set<number>();
    for (const h of view.heavy) {
      seen.add(h.id);
      let e = this.heavy.get(h.id);
      if (!e) {
        e = { obj: h.kind === 'rocket' ? ROCKET_MODEL() : GRENADE_MODEL(), kind: h.kind };
        this.heavy.set(h.id, e);
        this.scene.add(e.obj);
      }
      e.obj.position.set(h.x, h.y, 0.2);
      if (h.kind === 'rocket') {
        e.obj.rotation.z = Math.atan2(h.vy, h.vx);
        this.effects.trail(h.x - Math.cos(e.obj.rotation.z) * 0.3, h.y - Math.sin(e.obj.rotation.z) * 0.3);
      } else {
        e.obj.rotation.z -= h.vx * 0.02;
        const blink = e.obj.getObjectByName('blink');
        if (blink) blink.visible = Math.sin(time * (h.life < 0.8 ? 40 : 14)) > 0;
      }
    }
    for (const [id, e] of this.heavy) {
      if (!seen.has(id)) {
        this.scene.remove(e.obj);
        this.heavy.delete(id);
      }
    }
  }

  private updateCamera(view: GameView, dt: number, opts: FrameOptions): void {
    const map = this.map!;
    const cam = this.cam;
    let tx: number;
    let ty: number;
    const target: ViewPlayer | undefined = opts.followId ? view.players.find((p) => p.id === opts.followId) : undefined;
    if (target) {
      tx = target.x;
      ty = target.y + 2;
      if (opts.cursor && target.alive) {
        // Look ahead towards the cursor so players can see what they aim at.
        const w = this.screenToWorld(opts.cursor.x, opts.cursor.y);
        tx += THREE.MathUtils.clamp((w.x - target.x) * 0.3, -9, 9);
        ty += THREE.MathUtils.clamp((w.y - target.y) * 0.25, -5, 5);
      }
    } else {
      // Attract mode: drift across the map.
      this.panT += dt * 0.05;
      tx = map.width / 2 + Math.sin(this.panT) * map.width * 0.32;
      ty = map.height * 0.45 + Math.sin(this.panT * 1.7) * map.height * 0.15;
    }
    const k = 1 - Math.exp(-dt * (target ? 7 : 1.5));
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;

    const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const hh = cam.dist * tan;
    const hw = hh * this.camera.aspect;
    const minX = hw - 3;
    const maxX = map.width - hw + 3;
    const minY = map.killY + hh - 4;
    const maxY = map.height - hh + 3;
    const x = minX > maxX ? map.width / 2 : THREE.MathUtils.clamp(cam.x, minX, maxX);
    const y = minY > maxY ? map.height / 2 : THREE.MathUtils.clamp(cam.y, minY, maxY);

    this.shake = Math.max(0, this.shake - dt * 2.2);
    const s = opts.shake ? this.shake * this.shake : 0;
    const sx = (Math.random() - 0.5) * s * 1.6;
    const sy = (Math.random() - 0.5) * s * 1.6;
    this.camera.position.set(x + sx, y + 3 + sy, cam.dist);
    this.camera.lookAt(x + sx * 0.5, y + sy * 0.5, 0);
  }

  dispose(): void {
    removeEventListener('resize', this.onResize);
    this.clearEntities();
    this.env?.dispose();
    this.effects.dispose();
    this.padGeo.dispose();
    this.padMat.dispose();
    this.padMatOff.dispose();
    this.renderer.dispose();
  }
}
