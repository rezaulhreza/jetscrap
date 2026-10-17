import * as THREE from 'three';
import { SHOULDER_Y } from '../../shared/constants';
import type { ItemKind } from '../../shared/maps';
import type { WeaponId } from '../../shared/weapons';
import type { ViewPlayer } from '../session';

export const TEAM_COLORS = ['#f0643c', '#2ec4c9'];
export const FFA_COLORS = [
  '#f0643c', '#2ec4c9', '#f2b530', '#9b7bff', '#7bd88f', '#ff6fb5',
  '#4f8dff', '#ff9f43', '#c0e05a', '#e3e0d8', '#c4835f', '#5ad1a8',
];

export function playerColor(team: number, color: number): string {
  return team === 0 || team === 1 ? TEAM_COLORS[team] : FFA_COLORS[color % FFA_COLORS.length];
}

// Shared geometry and materials. Characters clone only the materials they flash.
const box = new THREE.BoxGeometry(1, 1, 1);
const cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
const cone = new THREE.ConeGeometry(0.5, 1, 10, 1, true);
const sphere = new THREE.SphereGeometry(0.5, 12, 8);

const std = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.25, flatShading: true, ...extra });

const MAT = {
  gun: std('#2d3238', { metalness: 0.6, roughness: 0.4 }),
  gunLight: std('#5b636c', { metalness: 0.5, roughness: 0.45 }),
  wood: std('#7a5233', { metalness: 0.05, roughness: 0.8 }),
  paint: std('#f2b530', { metalness: 0.2 }),
  dark: std('#262b31'),
  boot: std('#1b1e22'),
  strap: std('#3b3f45'),
};

function part(geo: THREE.BufferGeometry, mat: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** Builds a weapon pointing along +x with the grip at the origin. Returns the muzzle distance. */
export function makeWeapon(id: WeaponId): { group: THREE.Group; muzzle: number } {
  const g = new THREE.Group();
  const add = (m: THREE.Mesh) => g.add(m);
  let muzzle = 0.5;
  switch (id) {
    case 'pistol':
      add(part(box, MAT.gun, 0.34, 0.1, 0.07, 0.12, 0.04));
      add(part(box, MAT.gunLight, 0.08, 0.16, 0.06, 0.02, -0.06));
      add(part(box, MAT.paint, 0.04, 0.03, 0.075, 0.24, 0.08));
      muzzle = 0.3;
      break;
    case 'rifle': {
      add(part(box, MAT.gun, 0.62, 0.13, 0.08, 0.2, 0.03));
      const barrel = part(cyl, MAT.gunLight, 0.045, 0.32, 0.045, 0.66, 0.05);
      barrel.rotation.z = Math.PI / 2;
      add(barrel);
      const mag = part(box, MAT.dark, 0.1, 0.2, 0.06, 0.24, -0.1);
      mag.rotation.z = -0.25;
      add(mag);
      add(part(box, MAT.gun, 0.24, 0.12, 0.07, -0.18, -0.01));
      add(part(box, MAT.paint, 0.18, 0.025, 0.085, 0.3, 0.1));
      muzzle = 0.82;
      break;
    }
    case 'shotgun': {
      add(part(box, MAT.gun, 0.5, 0.12, 0.09, 0.2, 0.04));
      for (const dy of [0.02, 0.09]) {
        const b = part(cyl, MAT.gunLight, 0.06, 0.48, 0.06, 0.62, dy);
        b.rotation.z = Math.PI / 2;
        add(b);
      }
      add(part(box, MAT.wood, 0.22, 0.09, 0.1, 0.5, -0.04));
      add(part(box, MAT.wood, 0.28, 0.13, 0.08, -0.16, -0.01));
      muzzle = 0.86;
      break;
    }
    case 'sniper': {
      add(part(box, MAT.gun, 0.7, 0.11, 0.07, 0.22, 0.02));
      const b = part(cyl, MAT.gunLight, 0.035, 0.62, 0.035, 0.86, 0.04);
      b.rotation.z = Math.PI / 2;
      add(b);
      const scope = part(cyl, MAT.dark, 0.07, 0.3, 0.07, 0.24, 0.13);
      scope.rotation.z = Math.PI / 2;
      add(scope);
      add(part(box, MAT.gunLight, 0.08, 0.02, 0.071, 0.43, 0.13));
      add(part(box, MAT.gun, 0.28, 0.14, 0.07, -0.2, -0.02));
      add(part(box, MAT.paint, 0.05, 0.12, 0.075, 0.06, -0.04));
      muzzle = 1.17;
      break;
    }
    case 'rocket': {
      const tube = part(cyl, MAT.gunLight, 0.2, 1.05, 0.2, 0.22, 0.08);
      tube.rotation.z = Math.PI / 2;
      add(tube);
      const ring = part(cyl, MAT.paint, 0.24, 0.08, 0.24, 0.72, 0.08);
      ring.rotation.z = Math.PI / 2;
      add(ring);
      const back = part(cyl, MAT.dark, 0.23, 0.1, 0.23, -0.3, 0.08);
      back.rotation.z = Math.PI / 2;
      add(back);
      add(part(box, MAT.gun, 0.08, 0.18, 0.06, 0.05, -0.08));
      muzzle = 0.8;
      break;
    }
  }
  return { group: g, muzzle };
}

/**
 * A stylised soldier made from boxes: helmet with a lit visor, team-coloured suit,
 * jetpack with flames, and an arm rig that turns the weapon to the aim angle.
 */
export class CharacterModel {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private torso: THREE.Mesh;
  private head = new THREE.Group();
  private arm = new THREE.Group();
  private flames: THREE.Mesh[] = [];
  private weapons = new Map<WeaponId, { group: THREE.Group; muzzle: number }>();
  private flash: THREE.Mesh;
  private shield: THREE.Mesh;
  private suit: THREE.MeshStandardMaterial;
  private visor: THREE.MeshStandardMaterial;
  private trim: THREE.MeshStandardMaterial;
  private current: WeaponId | null = null;
  private phase = 0;
  private recoil = 0;
  private flashTime = 0;
  private hurt = 0;
  private deadTime = -1;
  private spawnTime = 1;
  private deathSpin = 0;
  readonly color: THREE.Color;

  constructor(colorHex: string) {
    this.color = new THREE.Color(colorHex);
    this.suit = std(colorHex, { metalness: 0.15, roughness: 0.55 });
    this.trim = std('#2b3036');
    this.visor = new THREE.MeshStandardMaterial({ color: '#111', emissive: this.color.clone().lerp(new THREE.Color('#ffffff'), 0.45), emissiveIntensity: 1.6, roughness: 0.2 });

    // Legs pivot at the hips.
    for (const [leg, z] of [[this.legL, 0.11], [this.legR, -0.11]] as const) {
      leg.position.set(0, 0.86, z);
      leg.add(part(box, this.trim, 0.2, 0.5, 0.2, 0, -0.25, 0));
      leg.add(part(box, this.suit, 0.21, 0.36, 0.21, 0, -0.62, 0));
      leg.add(part(box, MAT.boot, 0.3, 0.13, 0.24, 0.05, -0.8, 0));
      this.body.add(leg);
    }
    this.body.add(part(box, this.trim, 0.42, 0.18, 0.36, 0, 0.9, 0));
    this.torso = part(box, this.suit, 0.5, 0.56, 0.38, 0, 1.24, 0);
    this.body.add(this.torso);
    this.body.add(part(box, this.trim, 0.52, 0.12, 0.4, 0.01, 1.08, 0));
    this.body.add(part(box, MAT.strap, 0.06, 0.6, 0.41, 0.08, 1.24, 0));

    // Head with helmet and visor.
    this.head.position.set(0, 1.6, 0);
    this.head.add(part(box, this.suit, 0.38, 0.34, 0.36, 0, 0.1, 0));
    this.head.add(part(box, this.trim, 0.4, 0.08, 0.38, -0.01, 0.27, 0));
    this.head.add(part(box, this.visor, 0.1, 0.11, 0.3, 0.17, 0.1, 0));
    this.body.add(this.head);

    // Jetpack.
    const pack = new THREE.Group();
    pack.position.set(-0.34, 1.22, 0);
    pack.add(part(box, MAT.gunLight, 0.2, 0.5, 0.34));
    pack.add(part(box, MAT.paint, 0.21, 0.06, 0.35, 0, 0.18, 0));
    for (const z of [0.1, -0.1]) {
      pack.add(part(cyl, MAT.dark, 0.1, 0.14, 0.1, -0.02, -0.31, z));
      const flame = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
      flame.rotation.z = Math.PI;
      flame.position.set(-0.02, -0.62, z);
      flame.scale.set(0.12, 0.5, 0.12);
      flame.visible = false;
      this.flames.push(flame);
      pack.add(flame);
    }
    this.body.add(pack);

    // Arm rig at the shoulder.
    this.arm.position.set(0, SHOULDER_Y, 0.12);
    this.arm.add(part(box, this.suit, 0.42, 0.13, 0.14, 0.2, -0.03, 0.06));
    this.arm.add(part(box, this.trim, 0.12, 0.12, 0.14, 0.42, -0.04, 0.06));
    this.body.add(this.arm);

    this.flash = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: '#ffe8a3', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.flash.visible = false;
    this.arm.add(this.flash);

    this.shield = new THREE.Mesh(
      sphere,
      new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.shield.scale.set(1.5, 2.3, 1.2);
    this.shield.position.y = 0.95;
    this.shield.visible = false;
    this.root.add(this.shield);

    this.root.add(this.body);
  }

  private setWeapon(id: WeaponId): void {
    if (this.current === id) return;
    if (!this.weapons.has(id)) {
      const w = makeWeapon(id);
      w.group.position.set(0.4, -0.02, 0.1);
      this.arm.add(w.group);
      this.weapons.set(id, w);
    }
    for (const [k, w] of this.weapons) w.group.visible = k === id;
    this.current = id;
    this.flash.position.set(0.4 + this.weapons.get(id)!.muzzle + 0.15, 0.05, 0.1);
  }

  fire(id: WeaponId): void {
    this.recoil = id === 'rocket' || id === 'sniper' || id === 'shotgun' ? 0.22 : 0.09;
    this.flashTime = id === 'sniper' || id === 'shotgun' ? 0.07 : 0.045;
    this.flash.scale.setScalar(id === 'shotgun' || id === 'rocket' ? 0.8 : id === 'pistol' ? 0.38 : 0.55);
    this.flash.rotation.x = Math.random() * Math.PI;
  }

  /** World position of the current muzzle, for effects. */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.flash.getWorldPosition(out);
  }

  onHurt(): void {
    this.hurt = 0.12;
  }

  update(p: ViewPlayer, dt: number, time: number): void {
    const root = this.root;
    if (!p.alive) {
      if (this.deadTime < 0) {
        this.deadTime = 0;
        this.deathSpin = (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 4);
      }
      this.deadTime += dt;
      const t = this.deadTime;
      root.visible = t < 0.7;
      this.body.rotation.z += this.deathSpin * dt;
      this.body.position.y = Math.max(-0.6, 1.2 * t - 6 * t * t);
      const s = Math.max(0.01, 1 - Math.max(0, t - 0.35) * 3);
      this.body.scale.set(s * (this.body.scale.x < 0 ? -1 : 1), s, s);
      this.flames.forEach((f) => (f.visible = false));
      this.shield.visible = false;
      root.position.set(p.x, p.y, 0);
      return;
    }
    if (this.deadTime >= 0) {
      this.deadTime = -1;
      this.spawnTime = 0;
      this.body.rotation.z = 0;
      this.body.position.y = 0;
    }
    root.visible = true;
    root.position.set(p.x, p.y, 0);

    const facing = Math.cos(p.aim) >= 0 ? 1 : -1;
    this.spawnTime = Math.min(1, this.spawnTime + dt * 4);
    const pop = this.spawnTime < 1 ? 0.6 + 0.4 * Math.sin((this.spawnTime * Math.PI) / 2) : 1;
    this.body.scale.set(facing * pop, pop, pop);

    // Legs: run cycle on the ground, tucked in the air.
    const speed = Math.abs(p.vx);
    if (p.grounded && speed > 0.5) {
      // Running backwards (moving against the facing) plays the cycle in reverse.
      this.phase += dt * speed * 1.9 * (Math.sign(p.vx) === facing ? 1 : -1);
      const swing = Math.sin(this.phase) * Math.min(0.85, speed * 0.1);
      this.legL.rotation.z = swing;
      this.legR.rotation.z = -swing;
      this.body.position.y = Math.abs(Math.cos(this.phase)) * 0.05;
    } else if (!p.grounded) {
      const k = p.jetting ? 0.15 : 0.45;
      this.legL.rotation.z = THREE.MathUtils.lerp(this.legL.rotation.z, k, dt * 10);
      this.legR.rotation.z = THREE.MathUtils.lerp(this.legR.rotation.z, -k * 0.4 - 0.2, dt * 10);
      this.body.position.y = 0;
    } else {
      this.legL.rotation.z = THREE.MathUtils.lerp(this.legL.rotation.z, 0, dt * 12);
      this.legR.rotation.z = THREE.MathUtils.lerp(this.legR.rotation.z, 0, dt * 12);
      this.body.position.y = THREE.MathUtils.lerp(this.body.position.y, 0, dt * 12);
    }
    this.body.rotation.z = THREE.MathUtils.lerp(this.body.rotation.z, -THREE.MathUtils.clamp(p.vx * 0.012, -0.12, 0.12) * facing, dt * 8);

    // Arm and head follow the aim. The body is mirrored, so flip the angle when facing left.
    let local = facing > 0 ? p.aim : Math.PI - p.aim;
    if (local > Math.PI) local -= Math.PI * 2;
    this.arm.rotation.z = local;
    this.head.rotation.z = THREE.MathUtils.clamp(local * 0.4, -0.35, 0.35);
    this.setWeapon(p.weapon);
    this.recoil = Math.max(0, this.recoil - dt * 1.4);
    const w = this.weapons.get(p.weapon)!;
    w.group.position.x = 0.4 - this.recoil;
    w.group.rotation.z = p.reloading ? -0.6 + Math.sin(time * 9) * 0.1 : this.recoil * 0.8;

    this.flashTime -= dt;
    this.flash.visible = this.flashTime > 0;

    for (const f of this.flames) {
      f.visible = p.jetting;
      if (p.jetting) f.scale.set(0.13, 0.45 + Math.random() * 0.3, 0.13);
    }

    this.shield.visible = p.protect;
    if (p.protect) (this.shield.material as THREE.MeshBasicMaterial).opacity = 0.1 + 0.08 * Math.sin(time * 12);

    // Hit flash and power-up glow.
    this.hurt = Math.max(0, this.hurt - dt);
    const glow = this.hurt > 0 ? 1.2 : p.overdrive ? 0.35 + 0.2 * Math.sin(time * 10) : 0;
    this.suit.emissive.set(this.hurt > 0 ? '#ffffff' : p.overdrive ? '#ff2a1a' : p.haste ? '#ffd23a' : '#000000');
    this.suit.emissiveIntensity = this.hurt > 0 ? glow : p.overdrive ? glow : p.haste ? 0.25 : 0;
  }

  dispose(): void {
    this.suit.dispose();
    this.visor.dispose();
    this.trim.dispose();
    for (const f of this.flames) (f.material as THREE.Material).dispose();
    (this.flash.material as THREE.Material).dispose();
    this.flash.geometry.dispose();
    (this.shield.material as THREE.Material).dispose();
  }
}

const PICKUP_MAT = {
  white: std('#ece9e2'),
  red: new THREE.MeshStandardMaterial({ color: '#e0332b', emissive: '#a01510', emissiveIntensity: 0.6, flatShading: true }),
  blue: new THREE.MeshStandardMaterial({ color: '#5d8fe0', emissive: '#1d3f8a', emissiveIntensity: 0.6, metalness: 0.5, roughness: 0.3, flatShading: true }),
  olive: std('#5d6b3a'),
  overdrive: new THREE.MeshStandardMaterial({ color: '#ff4b3a', emissive: '#ff2a1a', emissiveIntensity: 1.2, flatShading: true }),
  haste: new THREE.MeshStandardMaterial({ color: '#ffd23a', emissive: '#ffb000', emissiveIntensity: 1.1, flatShading: true }),
  grenade: std('#4c5a3b'),
};

const octa = new THREE.OctahedronGeometry(0.32);
const ico = new THREE.IcosahedronGeometry(0.3);

/** Floating pickup model. Shapes differ by kind so they read without colour. */
export function makePickup(kind: ItemKind, weapon?: WeaponId): THREE.Group {
  const g = new THREE.Group();
  switch (kind) {
    case 'health':
      g.add(part(box, PICKUP_MAT.white, 0.5, 0.5, 0.5));
      g.add(part(box, PICKUP_MAT.red, 0.36, 0.1, 0.52));
      g.add(part(box, PICKUP_MAT.red, 0.1, 0.36, 0.52));
      break;
    case 'armor': {
      const plate = part(cyl, PICKUP_MAT.blue, 0.55, 0.16, 0.55);
      plate.rotation.x = Math.PI / 2;
      g.add(plate);
      g.add(part(box, MAT.paint, 0.08, 0.32, 0.18, 0, 0, 0.06));
      break;
    }
    case 'ammo':
      g.add(part(box, PICKUP_MAT.olive, 0.6, 0.36, 0.36));
      g.add(part(box, MAT.paint, 0.62, 0.07, 0.37, 0, 0.06, 0));
      g.add(part(box, MAT.gunLight, 0.12, 0.08, 0.2, 0, 0.22, 0));
      break;
    case 'grenades':
      for (const x of [-0.14, 0.14]) {
        g.add(part(sphere, PICKUP_MAT.grenade, 0.26, 0.3, 0.26, x, 0, 0));
        g.add(part(cyl, MAT.gunLight, 0.08, 0.1, 0.08, x, 0.18, 0));
      }
      break;
    case 'overdrive':
      g.add(new THREE.Mesh(octa, PICKUP_MAT.overdrive));
      break;
    case 'haste':
      g.add(new THREE.Mesh(ico, PICKUP_MAT.haste));
      break;
    case 'weapon': {
      const w = makeWeapon(weapon ?? 'rifle');
      w.group.scale.setScalar(1.25);
      w.group.position.x = -w.muzzle * 0.5;
      g.add(w.group);
      break;
    }
  }
  return g;
}

export const ROCKET_MODEL = () => {
  const g = new THREE.Group();
  const body = part(cyl, MAT.gunLight, 0.12, 0.45, 0.12);
  body.rotation.z = Math.PI / 2;
  g.add(body);
  const nose = part(cone, MAT.paint, 0.12, 0.16, 0.12, 0.3, 0, 0);
  nose.rotation.z = -Math.PI / 2;
  g.add(nose);
  return g;
};

const BLINK_MAT = new THREE.MeshBasicMaterial({ color: '#ff3b2f' });

export const GRENADE_MODEL = () => {
  const g = new THREE.Group();
  g.add(part(sphere, PICKUP_MAT.grenade, 0.3, 0.34, 0.3));
  const light = new THREE.Mesh(sphere, BLINK_MAT);
  light.scale.setScalar(0.09);
  light.position.y = 0.17;
  light.name = 'blink';
  g.add(light);
  return g;
};
