import * as THREE from 'three';
import type { MapDef } from '../../shared/maps';
import { raySolids } from '../../shared/physics';
import type { WeaponId } from '../../shared/weapons';

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  grow: number;
  gravity: number;
  drag: number;
  r: number;
  g: number;
  b: number;
}

/** Fixed-size particle pool drawn with one instanced mesh. The oldest particle is reused when full. */
class ParticlePool {
  readonly mesh: THREE.InstancedMesh;
  private items: Particle[] = [];
  private next = 0;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  constructor(capacity: number, material: THREE.Material, private fadeColor: boolean) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < capacity; i++) {
      this.items.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 0, grow: 0, gravity: 0, drag: 0, r: 1, g: 1, b: 1 });
      this.mesh.setColorAt(i, this.color.setRGB(0, 0, 0));
    }
    this.mesh.count = capacity;
  }

  /** Lower quality settings use only part of the pool. */
  limit = 1;

  emit(p: Partial<Particle> & { x: number; y: number }): void {
    const cap = Math.max(16, Math.floor(this.items.length * this.limit));
    const it = this.items[this.next];
    this.next = (this.next + 1) % cap;
    it.x = p.x;
    it.y = p.y;
    it.z = p.z ?? 0.3;
    it.vx = p.vx ?? 0;
    it.vy = p.vy ?? 0;
    it.vz = p.vz ?? 0;
    it.max = it.life = p.life ?? 0.5;
    it.size = p.size ?? 0.1;
    it.grow = p.grow ?? 0;
    it.gravity = p.gravity ?? 0;
    it.drag = p.drag ?? 0;
    it.r = p.r ?? 1;
    it.g = p.g ?? 1;
    it.b = p.b ?? 1;
  }

  update(dt: number): void {
    const d = this.dummy;
    for (let i = 0; i < this.items.length; i++) {
      const p = this.items[i];
      if (p.life <= 0) {
        d.scale.setScalar(0);
        d.position.set(0, -999, 0);
        d.updateMatrix();
        this.mesh.setMatrixAt(i, d.matrix);
        continue;
      }
      p.life -= dt;
      const k = Math.max(0, p.life / p.max);
      const drag = Math.exp(-p.drag * dt);
      p.vx *= drag;
      p.vy = p.vy * drag - p.gravity * dt;
      p.vz *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.size += p.grow * dt;
      d.position.set(p.x, p.y, p.z);
      d.rotation.set(p.x * 3, p.y * 3, 0);
      const s = this.fadeColor ? p.size : p.size * k;
      d.scale.setScalar(Math.max(0, s));
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
      const c = this.fadeColor ? k : 1;
      this.mesh.setColorAt(i, this.color.setRGB(p.r * c, p.g * c, p.b * c));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    for (const p of this.items) p.life = 0;
  }
}

interface Tracer {
  id: number;
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  travelled: number;
  color: THREE.Color;
  width: number;
  /** Predicted local shots stop at other players' rendered positions. */
  predicted: boolean;
}

const BLAST_TIME = 0.38;

const TRACER_COLORS: Record<WeaponId, string> = {
  pistol: '#ffe9a8',
  rifle: '#ffd27a',
  shotgun: '#ffb070',
  sniper: '#c8f0ff',
  rocket: '#ffffff',
};

interface Blast {
  mesh: THREE.Mesh;
  ring: THREE.Mesh;
  life: number;
  r: number;
}

/**
 * Pooled visual effects: bullet tracers, sparks, smoke, explosions and flash lights.
 * Everything is preallocated so long matches do not allocate per shot.
 */
export class Effects {
  readonly group = new THREE.Group();
  private sparks: ParticlePool;
  private smoke: ParticlePool;
  private tracers: Tracer[] = [];
  private tracerMesh: THREE.InstancedMesh;
  private blasts: Blast[] = [];
  private lights: { light: THREE.PointLight; life: number; max: number; peak: number }[] = [];
  private dummy = new THREE.Object3D();
  private map: MapDef | null = null;
  private colorCache = new Map<string, THREE.Color>();
  /** Bodies that predicted local shots can stop on: [x, y] of each other living player's feet. */
  targets: { x: number; y: number }[] = [];

  constructor() {
    this.sparks = new ParticlePool(600, new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }), true);
    this.smoke = new ParticlePool(260, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.38, depthWrite: false }), false);
    this.group.add(this.sparks.mesh, this.smoke.mesh);

    this.tracerMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
      220,
    );
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracerMesh.frustumCulled = false;
    for (let i = 0; i < 220; i++) this.tracerMesh.setColorAt(i, new THREE.Color(0, 0, 0));
    this.group.add(this.tracerMesh);

    const sphere = new THREE.SphereGeometry(1, 16, 12);
    const ringGeo = new THREE.RingGeometry(0.93, 1, 40);
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color: '#ffb347', blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#fff2c4', blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      mesh.visible = ring.visible = false;
      this.group.add(mesh, ring);
      this.blasts.push({ mesh, ring, life: 0, r: 1 });
    }
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight('#ffb35c', 0, 14, 1.6);
      light.position.z = 2;
      this.group.add(light);
      this.lights.push({ light, life: 0, max: 1, peak: 0 });
    }
  }

  setMap(map: MapDef): void {
    this.map = map;
    this.clear();
  }

  setQuality(q: 'low' | 'medium' | 'high'): void {
    const f = q === 'low' ? 0.35 : q === 'medium' ? 0.65 : 1;
    this.sparks.limit = f;
    this.smoke.limit = f;
  }

  clear(): void {
    this.sparks.clear();
    this.smoke.clear();
    this.tracers = [];
    for (const b of this.blasts) {
      b.life = 0;
      b.mesh.visible = b.ring.visible = false;
    }
    for (const l of this.lights) {
      l.life = 0;
      l.light.intensity = 0;
    }
  }

  private col(hex: string): THREE.Color {
    let c = this.colorCache.get(hex);
    if (!c) {
      c = new THREE.Color(hex);
      this.colorCache.set(hex, c);
    }
    return c;
  }

  private flashLight(x: number, y: number, color: string, peak: number, dur: number): void {
    let slot = this.lights[0];
    for (const l of this.lights) if (l.life < slot.life) slot = l;
    slot.light.color.set(color);
    slot.light.position.set(x, y, 1.6);
    slot.life = slot.max = dur;
    slot.peak = peak;
  }

  bullet(id: number, owner: number, w: WeaponId, x: number, y: number, vx: number, vy: number, life: number, predicted: boolean): void {
    if (this.tracers.length >= 200) this.tracers.shift();
    this.tracers.push({ id, owner, x, y, vx, vy, life, travelled: 0, color: this.col(TRACER_COLORS[w]), width: w === 'sniper' ? 0.09 : w === 'shotgun' ? 0.045 : 0.06, predicted });
  }

  /** The server reported where a bullet stopped. */
  impact(id: number, x: number, y: number, flesh: boolean, color: string): void {
    const i = this.tracers.findIndex((t) => t.id === id);
    if (i >= 0) this.tracers.splice(i, 1);
    if (flesh) this.hitSpray(x, y, color);
    else this.wallSparks(x, y);
  }

  /** Stops the newest predicted local tracers when the server confirms a hit near them. */
  impactNear(owner: number, x: number, y: number): void {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      if (t.owner === owner && t.predicted && Math.hypot(t.x - x, t.y - y) < 4) {
        this.tracers.splice(i, 1);
        return;
      }
    }
  }

  wallSparks(x: number, y: number): void {
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 3 + Math.random() * 7;
      this.sparks.emit({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.18 + Math.random() * 0.15, size: 0.06, gravity: 18, r: 1, g: 0.8, b: 0.45 });
    }
    this.smoke.emit({ x, y, vy: 0.6, life: 0.5, size: 0.35, grow: 0.6, r: 0.55, g: 0.55, b: 0.55 });
  }

  hitSpray(x: number, y: number, hex: string): void {
    const c = this.col(hex);
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 2 + Math.random() * 5;
      this.sparks.emit({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s + 2, life: 0.3, size: 0.09, gravity: 14, r: c.r, g: c.g, b: c.b });
    }
  }

  muzzle(x: number, y: number, a: number, w: WeaponId): void {
    const n = w === 'shotgun' ? 8 : w === 'rocket' ? 10 : 3;
    for (let i = 0; i < n; i++) {
      const aa = a + (Math.random() - 0.5) * 0.6;
      const s = 4 + Math.random() * 6;
      this.sparks.emit({ x, y, vx: Math.cos(aa) * s, vy: Math.sin(aa) * s, life: 0.08 + Math.random() * 0.08, size: 0.07, r: 1, g: 0.85, b: 0.5 });
    }
    if (w === 'rocket' || w === 'shotgun' || w === 'sniper') {
      this.smoke.emit({ x, y, vx: Math.cos(a) * 1.5, vy: Math.sin(a) * 1.5 + 0.5, life: 0.7, size: 0.4, grow: 1, r: 0.6, g: 0.6, b: 0.6 });
    }
    this.flashLight(x, y, '#ffcf7a', w === 'sniper' || w === 'shotgun' || w === 'rocket' ? 18 : 9, 0.06);
  }

  explosion(x: number, y: number, r: number): void {
    let slot = this.blasts[0];
    for (const b of this.blasts) if (b.life < slot.life) slot = b;
    slot.life = BLAST_TIME;
    slot.r = r;
    slot.mesh.position.set(x, y, 0.2);
    slot.ring.position.set(x, y, 0.5);
    slot.mesh.visible = slot.ring.visible = true;
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 4 + Math.random() * 14;
      const hot = Math.random();
      this.sparks.emit({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s + 3, vz: (Math.random() - 0.5) * 6, life: 0.3 + Math.random() * 0.5, size: 0.1 + Math.random() * 0.12, gravity: 16, drag: 1.5, r: 1, g: 0.5 + hot * 0.4, b: 0.15 * hot });
    }
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 1 + Math.random() * 3;
      this.smoke.emit({ x: x + Math.cos(a) * r * 0.3, y: y + Math.sin(a) * r * 0.3, z: -0.6, vx: Math.cos(a) * s, vy: Math.sin(a) * s + 1.5, life: 0.7 + Math.random() * 0.5, size: 0.45 + Math.random() * 0.35, grow: 0.7, drag: 1.2, r: 0.25, g: 0.23, b: 0.22 });
    }
    this.flashLight(x, y, '#ff9a3c', 60, 0.35);
  }

  deathBurst(x: number, y: number, hex: string): void {
    const c = this.col(hex);
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 2 + Math.random() * 8;
      const pick = Math.random() < 0.5;
      this.sparks.emit({ x: x + (Math.random() - 0.5) * 0.6, y: y + 0.4 + Math.random() * 1.2, vx: Math.cos(a) * s, vy: Math.sin(a) * s + 3, vz: (Math.random() - 0.5) * 4, life: 0.5 + Math.random() * 0.5, size: 0.08 + Math.random() * 0.1, gravity: 18, drag: 0.5, r: pick ? c.r : 1, g: pick ? c.g : 0.8, b: pick ? c.b : 0.5 });
    }
    this.smoke.emit({ x, y: y + 0.9, life: 0.8, size: 0.9, grow: 1.4, r: 0.3, g: 0.3, b: 0.32 });
  }

  spawnRing(x: number, y: number, hex: string): void {
    const c = this.col(hex);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      this.sparks.emit({ x: x + Math.cos(a) * 0.7, y: y + 0.05, z: Math.sin(a) * 0.7, vy: 3 + Math.random() * 2, life: 0.5, size: 0.08, drag: 2, r: c.r, g: c.g, b: c.b });
    }
  }

  pickupFlash(x: number, y: number, hex: string): void {
    const c = this.col(hex);
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      this.sparks.emit({ x, y: y + 0.6, vx: Math.cos(a) * 3, vy: Math.sin(a) * 3 + 1, life: 0.35, size: 0.08, drag: 3, r: c.r, g: c.g, b: c.b });
    }
  }

  jetPuff(x: number, y: number): void {
    this.sparks.emit({ x: x + (Math.random() - 0.5) * 0.2, y, z: 0, vx: (Math.random() - 0.5) * 1.5, vy: -6 - Math.random() * 3, life: 0.16, size: 0.09, r: 1, g: 0.62, b: 0.2 });
    if (Math.random() < 0.3) this.smoke.emit({ x, y: y - 0.3, z: -0.1, vx: (Math.random() - 0.5), vy: -1.5, life: 0.5, size: 0.22, grow: 0.8, r: 0.5, g: 0.5, b: 0.52 });
  }

  trail(x: number, y: number): void {
    this.smoke.emit({ x, y, z: 0, vy: 0.4, life: 0.55, size: 0.25, grow: 0.9, r: 0.62, g: 0.6, b: 0.58 });
    this.sparks.emit({ x, y, life: 0.1, size: 0.12, r: 1, g: 0.6, b: 0.2 });
  }

  hazardSpark(x: number, y: number, hex: string): void {
    const c = this.col(hex);
    this.sparks.emit({ x, y, vx: (Math.random() - 0.5) * 2, vy: 1 + Math.random() * 3, life: 0.4, size: 0.06, gravity: 4, r: c.r, g: c.g, b: c.b });
  }

  update(dt: number): void {
    this.sparks.update(dt);
    this.smoke.update(dt);

    // Tracers.
    const d = this.dummy;
    let n = 0;
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      let dx = t.vx * dt;
      let dy = t.vy * dt;
      let end = t.life <= 0;
      if (this.map && !end) {
        const f = raySolids(this.map, t.x, t.y, t.x + dx, t.y + dy);
        if (f < 1) {
          dx *= f;
          dy *= f;
          end = true;
          this.wallSparks(t.x + dx, t.y + dy);
        }
      }
      if (t.predicted && !end) {
        for (const b of this.targets) {
          const px = t.x + dx;
          const py = t.y + dy;
          if (Math.abs(px - b.x) < 0.45 && py > b.y && py < b.y + 1.8) {
            end = true;
            break;
          }
        }
      }
      t.x += dx;
      t.y += dy;
      t.travelled += Math.hypot(dx, dy);
      if (end) {
        this.tracers.splice(i, 1);
        continue;
      }
      const sp = Math.hypot(t.vx, t.vy) || 1;
      const len = Math.min(t.travelled, sp * 0.035, 3.2);
      d.position.set(t.x - (t.vx / sp) * len * 0.5, t.y - (t.vy / sp) * len * 0.5, 0.15);
      d.rotation.set(0, 0, Math.atan2(t.vy, t.vx));
      d.scale.set(len, t.width, t.width);
      d.updateMatrix();
      this.tracerMesh.setMatrixAt(n, d.matrix);
      this.tracerMesh.setColorAt(n, t.color);
      n++;
    }
    this.tracerMesh.count = n;
    this.tracerMesh.instanceMatrix.needsUpdate = true;
    if (this.tracerMesh.instanceColor) this.tracerMesh.instanceColor.needsUpdate = true;

    // Explosions.
    for (const b of this.blasts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      const k = 1 - Math.max(0, b.life) / BLAST_TIME;
      // A quick core flash, then a thin shockwave ring that marks the damage radius.
      b.mesh.scale.setScalar(b.r * (0.2 + Math.pow(k, 0.5) * 0.45));
      const fade = Math.pow(1 - k, 2) * 0.75;
      (b.mesh.material as THREE.MeshBasicMaterial).color.setRGB(1, 0.55 + 0.3 * (1 - k), 0.2).multiplyScalar(fade);
      b.ring.scale.setScalar(b.r * (0.35 + k * 0.75));
      (b.ring.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.55;
      if (b.life <= 0) b.mesh.visible = b.ring.visible = false;
    }

    for (const l of this.lights) {
      if (l.life <= 0) {
        l.light.intensity = 0;
        continue;
      }
      l.life -= dt;
      l.light.intensity = l.peak * Math.max(0, l.life / l.max);
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  }
}
