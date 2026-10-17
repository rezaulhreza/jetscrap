import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MapDef, MapTheme, Rect } from '../../shared/maps';
import { mulberry32 } from '../../shared/rng';

/** Depth of solid blocks; the play plane is z = 0. Front faces sit close to it. */
const FRONT = 1.1;
const BACK = -4;

function panelTexture(base: string, line: string, seed: number, rivets: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const rand = mulberry32(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  // Grime and wear.
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(0,0,0,${rand() * 0.07})`;
    const s = 4 + rand() * 30;
    g.fillRect(rand() * 256, rand() * 256, s, s * (0.3 + rand()));
  }
  for (let i = 0; i < 80; i++) {
    g.fillStyle = `rgba(255,255,255,${rand() * 0.05})`;
    g.fillRect(rand() * 256, rand() * 256, 1 + rand() * 20, 1 + rand() * 2);
  }
  // Panel seams.
  g.strokeStyle = line;
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, 253, 253);
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, 128);
  g.lineTo(256, 128);
  g.moveTo(128, 0);
  g.lineTo(128, 128);
  g.stroke();
  if (rivets) {
    g.fillStyle = 'rgba(0,0,0,0.35)';
    for (const [x, y] of [[10, 10], [246, 10], [10, 246], [246, 246], [118, 118], [138, 118], [10, 118], [246, 118]]) {
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Box geometry whose UVs tile once per `tile` world units on every face. */
function tiledBox(w: number, h: number, d: number, tile: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  // Face order: +x, -x, +y, -y, +z, -z; 4 vertices each.
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * (dims[f][0] / tile), uv.getY(i) * (dims[f][1] / tile));
    }
  }
  return g;
}

function boxAt(r: Rect, z0: number, z1: number, tile: number): THREE.BufferGeometry {
  const g = tiledBox(r.w, r.h, z1 - z0, tile);
  g.translate(r.x + r.w / 2, r.y + r.h / 2, (z0 + z1) / 2);
  return g;
}

export interface Environment {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  update(dt: number, time: number, sparks: (x: number, y: number, hex: string) => void): void;
  dispose(): void;
}

/** Builds the playable geometry, backdrop, hazards and lights for a map. */
export function buildEnvironment(map: MapDef, scene: THREE.Scene): Environment {
  const t = map.theme;
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T) => {
    disposables.push(x);
    return x;
  };
  const rand = mulberry32(map.width * 31 + map.height);

  scene.background = new THREE.Color(t.skyBottom);
  scene.fog = new THREE.Fog(t.fog, 45, 150);

  // Sky gradient dome behind everything.
  const skyMat = track(new THREE.ShaderMaterial({
    uniforms: { top: { value: new THREE.Color(t.skyTop) }, bottom: { value: new THREE.Color(t.skyBottom) } },
    vertexShader: 'varying vec3 vP; void main(){ vP = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vP,1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp((vP.y + 40.0) / 140.0, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, pow(h, 0.8)), 1.0); }',
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  }));
  const sky = new THREE.Mesh(track(new THREE.SphereGeometry(400, 24, 12)), skyMat);
  sky.position.set(map.width / 2, 0, 0);
  group.add(sky);

  // Lighting.
  const hemi = new THREE.HemisphereLight(t.sun, t.ambient, 2.1);
  group.add(hemi);
  const sun = new THREE.DirectionalLight(t.sun, 2.4);
  sun.position.set(map.width * 0.42, map.height + 20, 60);
  sun.target.position.set(map.width / 2, map.height / 2, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -map.width * 0.65;
  sc.right = map.width * 0.65;
  sc.top = map.height * 0.9;
  sc.bottom = -map.height * 0.9;
  sc.near = 1;
  sc.far = 200;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.03;
  group.add(sun, sun.target);

  // Solid blocks: one merged mesh with a tiled panel texture.
  const solidTex = track(panelTexture(t.solid, 'rgba(0,0,0,0.35)', 7, t.style !== 'city'));
  const solidMat = track(new THREE.MeshStandardMaterial({ map: solidTex, roughness: 0.82, metalness: t.style === 'arctic' ? 0.05 : 0.3 }));
  const inner = map.solids;
  const solidGeos = inner.map((r) => boxAt(r, BACK, FRONT, 4));
  const solids = new THREE.Mesh(track(mergeGeometries(solidGeos)), solidMat);
  solidGeos.forEach((g) => g.dispose());
  solids.castShadow = true;
  solids.receiveShadow = true;
  group.add(solids);

  // Painted trim along the top front edge of every solid, so walkable tops read clearly.
  const trimMat = track(new THREE.MeshStandardMaterial({ color: t.trim, roughness: 0.5, emissive: t.trim, emissiveIntensity: 0.18 }));
  const trimGeos = inner
    .filter((r) => r.w < map.width)
    .map((r) => {
      const g = new THREE.BoxGeometry(r.w + 0.04, 0.12, 0.14);
      g.translate(r.x + r.w / 2, r.y + r.h - 0.06, FRONT + 0.02);
      return g;
    });
  if (trimGeos.length) {
    const trim = new THREE.Mesh(track(mergeGeometries(trimGeos)), trimMat);
    trimGeos.forEach((g) => g.dispose());
    group.add(trim);
  }

  // One-way platforms: thin grates with brackets into the back wall.
  const platMat = track(new THREE.MeshStandardMaterial({ color: t.platform, roughness: 0.6, metalness: 0.45 }));
  const platGeos: THREE.BufferGeometry[] = [];
  for (const r of map.platforms) {
    platGeos.push(boxAt(r, -2.2, FRONT * 0.8, 2));
    for (const bx of [r.x + 0.4, r.x + r.w - 0.4]) {
      const b = new THREE.BoxGeometry(0.16, 0.9, 0.16);
      b.translate(bx, r.y - 0.45, -1.9);
      platGeos.push(b);
    }
    const lip = new THREE.BoxGeometry(r.w, 0.08, 0.1);
    lip.translate(r.x + r.w / 2, r.y + r.h - 0.04, FRONT * 0.8 + 0.03);
    platGeos.push(lip);
  }
  if (platGeos.length) {
    const plats = new THREE.Mesh(track(mergeGeometries(platGeos.map((g) => g.index ? g.toNonIndexed() : g))), platMat);
    platGeos.forEach((g) => g.dispose());
    plats.castShadow = true;
    plats.receiveShadow = true;
    group.add(plats);
  }

  // Back wall behind the arena for interior maps.
  if (t.style !== 'city') {
    // Much darker and less saturated than the walkable blocks, so the play space reads in front of it.
    const wallBase = new THREE.Color(t.fog).lerp(new THREE.Color('#20242a'), 0.5).multiplyScalar(t.style === 'arctic' ? 0.75 : 0.6);
    const wallTex = track(panelTexture(wallBase.getStyle(), 'rgba(0,0,0,0.3)', 11, true));
    const wallMat = track(new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.95 }));
    const wall = new THREE.Mesh(track(tiledBox(map.width, map.height - map.killY, 0.5, 6)), wallMat);
    wall.position.set(map.width / 2, (map.height + map.killY) / 2, BACK - 5);
    wall.receiveShadow = true;
    group.add(wall);
    // Vertical girders on the back wall give depth cues while moving.
    const girderGeos: THREE.BufferGeometry[] = [];
    for (let x = 6; x < map.width; x += 12) {
      const g = new THREE.BoxGeometry(0.7, map.height - map.killY, 0.6);
      g.translate(x, (map.height + map.killY) / 2, BACK - 4.4);
      girderGeos.push(g);
    }
    const girders = new THREE.Mesh(track(mergeGeometries(girderGeos)), track(new THREE.MeshStandardMaterial({ color: wallBase.clone().multiplyScalar(0.7), roughness: 0.7, metalness: 0.5 })));
    girderGeos.forEach((g) => g.dispose());
    girders.receiveShadow = true;
    group.add(girders);
  }

  // Hazards.
  const hazardMats: THREE.MeshStandardMaterial[] = [];
  for (const h of map.hazards) {
    const mat = track(new THREE.MeshStandardMaterial({ color: t.hazard, emissive: t.hazard, emissiveIntensity: 0.9, transparent: true, opacity: h.kind === 'acid' ? 0.85 : 0.7, roughness: 0.2 }));
    hazardMats.push(mat);
    const m = new THREE.Mesh(track(boxAt(h, BACK + 0.4, FRONT + 0.05, 2)), mat);
    group.add(m);
    if (h.kind === 'shock') {
      // Warning stripes along the edge.
      const stripeTex = track(stripeTexture());
      const stripe = new THREE.Mesh(track(new THREE.PlaneGeometry(h.w, 0.25)), track(new THREE.MeshBasicMaterial({ map: stripeTex })));
      stripeTex.repeat.set(h.w / 1.2, 1);
      stripe.position.set(h.x + h.w / 2, h.y - 0.15, FRONT + 0.08);
      group.add(stripe);
    }
    const light = new THREE.PointLight(t.hazard, 6, 12, 1.5);
    light.position.set(h.x + h.w / 2, h.y + 1.5, 2);
    group.add(light);
  }

  // Backdrop silhouettes and ambient particles by theme.
  const backdrop = buildBackdrop(map, t, rand, track);
  group.add(backdrop);
  const ambient = buildAmbient(map, t, track);
  group.add(ambient.points);

  scene.add(group);

  return {
    group,
    sun,
    update(dt, time, sparks) {
      for (let i = 0; i < hazardMats.length; i++) {
        const h = map.hazards[i];
        hazardMats[i].emissiveIntensity = h.kind === 'shock' ? (Math.random() < 0.15 ? 2.4 : 0.6) : 0.8 + Math.sin(time * 3 + i) * 0.25;
        if (Math.random() < dt * (h.kind === 'shock' ? 18 : 8)) sparks(h.x + Math.random() * h.w, h.y + h.h, t.hazard);
      }
      ambient.update(dt);
    },
    dispose() {
      scene.remove(group);
      for (const d of disposables) d.dispose();
    },
  };
}

function stripeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 16;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1b1b1b';
  g.fillRect(0, 0, 64, 16);
  g.fillStyle = '#f2b530';
  for (let x = -16; x < 64; x += 32) {
    g.beginPath();
    g.moveTo(x, 16);
    g.lineTo(x + 16, 0);
    g.lineTo(x + 32, 0);
    g.lineTo(x + 16, 16);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function windowTexture(lit: string, seed: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  const rand = mulberry32(seed);
  g.fillStyle = '#000';
  g.fillRect(0, 0, 64, 128);
  for (let y = 4; y < 128; y += 10) {
    for (let x = 4; x < 64; x += 10) {
      if (rand() < 0.38) {
        g.globalAlpha = 0.4 + rand() * 0.6;
        g.fillStyle = lit;
        g.fillRect(x, y, 6, 6);
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildBackdrop(map: MapDef, t: MapTheme, rand: () => number, track: <T extends { dispose(): void }>(x: T) => T): THREE.Group {
  const g = new THREE.Group();
  const W = map.width;
  const dark = new THREE.Color(t.fog).lerp(new THREE.Color('#000'), 0.35);
  const silhouette = track(new THREE.MeshStandardMaterial({ color: dark, roughness: 1 }));

  if (t.style === 'city') {
    // Skyline with lit windows at two depths, plus the arena's own building bodies falling away below.
    const winTex = track(windowTexture('#ffd9a0', 3));
    for (const [z, count, hMax] of [[-55, 24, 70], [-110, 32, 120]] as const) {
      const mat = track(new THREE.MeshStandardMaterial({ color: dark.clone().multiplyScalar(0.7), emissive: '#ffffff', emissiveMap: winTex, emissiveIntensity: z < -80 ? 0.18 : 0.3, roughness: 1 }));
      for (let i = 0; i < count; i++) {
        const w = 5 + rand() * 9;
        const h = 18 + rand() * hMax;
        const x = -90 + (i / count) * (W + 180) + rand() * 4;
        const geo = track(new THREE.BoxGeometry(w, h, 6));
        const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
        for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * (w / 6), uv.getY(k) * (h / 12));
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, -30 + h / 2, z);
        g.add(m);
      }
    }
    // Neon signs.
    const neon = track(new THREE.MeshBasicMaterial({ color: t.accent }));
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(track(new THREE.BoxGeometry(3 + rand() * 4, 0.5, 0.2)), neon);
      m.position.set(rand() * W, 10 + rand() * 35, -45);
      g.add(m);
    }
  } else if (t.style === 'foundry') {
    // Smokestacks and silos with glowing furnace mouths.
    const glow = track(new THREE.MeshBasicMaterial({ color: t.accent }));
    for (let i = 0; i < 14; i++) {
      const r = 1.5 + rand() * 3;
      const h = 30 + rand() * 50;
      const m = new THREE.Mesh(track(new THREE.CylinderGeometry(r * 0.8, r, h, 12)), silhouette);
      m.position.set(-30 + rand() * (W + 60), -6 + h / 2, -26 - rand() * 50);
      g.add(m);
      if (rand() < 0.5) {
        const mouth = new THREE.Mesh(track(new THREE.BoxGeometry(r * 1.2, 1.2, 0.3)), glow);
        mouth.position.set(m.position.x, 2 + rand() * 6, m.position.z + r);
        g.add(mouth);
      }
    }
  } else {
    // Ice ridges and relay masts.
    const snow = track(new THREE.MeshStandardMaterial({ color: '#dce8f2', roughness: 0.9, flatShading: true }));
    for (let i = 0; i < 12; i++) {
      const r = 15 + rand() * 25;
      const h = 25 + rand() * 45;
      const m = new THREE.Mesh(track(new THREE.ConeGeometry(r, h, 6)), rand() < 0.5 ? snow : silhouette);
      m.position.set(-50 + rand() * (W + 100), -6 + h / 2, -60 - rand() * 60);
      g.add(m);
    }
    const mast = track(new THREE.MeshStandardMaterial({ color: '#3a4552' }));
    const beacon = track(new THREE.MeshBasicMaterial({ color: '#ff4040' }));
    for (let i = 0; i < 4; i++) {
      const h = 40 + rand() * 20;
      const m = new THREE.Mesh(track(new THREE.BoxGeometry(0.8, h, 0.8)), mast);
      m.position.set(rand() * W, h / 2 - 6, -35);
      g.add(m);
      const b = new THREE.Mesh(track(new THREE.SphereGeometry(0.6, 8, 6)), beacon);
      b.position.set(m.position.x, h - 6, -35);
      g.add(b);
    }
  }
  return g;
}

function buildAmbient(map: MapDef, t: MapTheme, track: <T extends { dispose(): void }>(x: T) => T) {
  const count = 260;
  const pos = new Float32Array(count * 3);
  const vel = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = Math.random() * map.width;
    pos[i * 3 + 1] = map.killY + Math.random() * (map.height - map.killY);
    pos[i * 3 + 2] = -6 + Math.random() * 9;
    vel[i] = 0.4 + Math.random() * 1.2;
  }
  const geo = track(new THREE.BufferGeometry());
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const color = t.style === 'arctic' ? '#ffffff' : t.style === 'foundry' ? '#ffb070' : '#bfe9ff';
  const mat = track(new THREE.PointsMaterial({ color, size: t.style === 'arctic' ? 0.16 : 0.09, transparent: true, opacity: 0.75, depthWrite: false, blending: t.style === 'arctic' ? THREE.NormalBlending : THREE.AdditiveBlending }));
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  // Snow falls; embers and city dust rise.
  const dir = t.style === 'arctic' ? -1 : 1;
  return {
    points,
    update(dt: number) {
      const a = geo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < count; i++) {
        let y = pos[i * 3 + 1] + vel[i] * dt * dir;
        pos[i * 3] += Math.sin(y * 0.7 + i) * dt * 0.4;
        if (y > map.height) y = map.killY;
        if (y < map.killY) y = map.height;
        pos[i * 3 + 1] = y;
      }
      a.needsUpdate = true;
    },
  };
}
