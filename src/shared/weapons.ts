export type WeaponId = 'pistol' | 'rifle' | 'shotgun' | 'sniper' | 'rocket';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  /** The pistol is the fixed secondary weapon; every other weapon goes in the primary slot. */
  secondary: boolean;
  damage: number;
  pellets: number;
  /** Seconds between shots. */
  interval: number;
  mag: number;
  /** Spare ammunition in a fresh pickup. The secondary weapon has unlimited spare ammunition. */
  reserve: number;
  maxReserve: number;
  reload: number;
  /** Random spread in radians (half-angle). */
  spread: number;
  speed: number;
  /** Projectile lifetime in seconds. */
  life: number;
  kind: 'bullet' | 'rocket';
  headMult: number;
  /** Explosion radius for rockets. */
  radius: number;
  /** Knockback impulse applied to the target. */
  knock: number;
  /** Bot range preference: [min, ideal, max] distance. */
  range: [number, number, number];
  /** Bot pickup preference, higher is better. */
  rank: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: {
    id: 'pistol', name: 'Sparrow P9', secondary: true,
    damage: 17, pellets: 1, interval: 0.26, mag: 12, reserve: 0, maxReserve: 0, reload: 1.05,
    spread: 0.025, speed: 80, life: 0.55, kind: 'bullet', headMult: 1.5, radius: 0, knock: 1.5,
    range: [3, 10, 22], rank: 0,
  },
  rifle: {
    id: 'rifle', name: 'Hornet AR', secondary: false,
    damage: 10, pellets: 1, interval: 0.095, mag: 30, reserve: 90, maxReserve: 150, reload: 1.6,
    spread: 0.045, speed: 88, life: 0.55, kind: 'bullet', headMult: 1.5, radius: 0, knock: 1.2,
    range: [4, 13, 26], rank: 2,
  },
  shotgun: {
    id: 'shotgun', name: 'Mauler 12', secondary: false,
    damage: 9, pellets: 8, interval: 0.78, mag: 6, reserve: 18, maxReserve: 30, reload: 1.9,
    spread: 0.2, speed: 62, life: 0.3, kind: 'bullet', headMult: 1.25, radius: 0, knock: 2.2,
    range: [0, 5, 10], rank: 3,
  },
  sniper: {
    id: 'sniper', name: 'Longbow', secondary: false,
    damage: 72, pellets: 1, interval: 1.15, mag: 5, reserve: 10, maxReserve: 20, reload: 2.3,
    spread: 0.004, speed: 170, life: 0.5, kind: 'bullet', headMult: 2, radius: 0, knock: 6,
    range: [10, 22, 45], rank: 3,
  },
  rocket: {
    id: 'rocket', name: 'Thumper RL', secondary: false,
    damage: 92, pellets: 1, interval: 1.05, mag: 1, reserve: 4, maxReserve: 6, reload: 1.5,
    spread: 0.01, speed: 30, life: 2.2, kind: 'rocket', headMult: 1, radius: 3.4, knock: 16,
    range: [6, 12, 24], rank: 4,
  },
};

export const PRIMARY_WEAPONS: WeaponId[] = ['rifle', 'shotgun', 'sniper', 'rocket'];

export interface WeaponState {
  id: WeaponId;
  mag: number;
  reserve: number;
}

export function freshWeapon(id: WeaponId): WeaponState {
  const def = WEAPONS[id];
  return { id, mag: def.mag, reserve: def.reserve };
}
