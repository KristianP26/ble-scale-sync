import { describe, it, expect } from 'vitest';
import { ownerOfSlot } from '../../src/config/user-matching.js';
import type { UserConfig } from '../../src/config/schema.js';

const base = {
  height: 170,
  birth_date: '1990-01-01',
  gender: 'male' as const,
  is_athlete: false,
  weight_range: { min: 40, max: 150 },
  last_known_weight: null,
};

const brian: UserConfig = { ...base, name: 'Alice', slug: 'brian', beurer_user_index: 1 };
const carla: UserConfig = { ...base, name: 'Bob', slug: 'carla', beurer_user_index: 2 };
const unslotted: UserConfig = { ...base, name: 'Guest', slug: 'guest' };

describe('ownerOfSlot', () => {
  it('returns the single user who claims the slot', () => {
    expect(ownerOfSlot([brian, carla], 2)).toBe(carla);
  });

  it('returns null when the frame names no slot', () => {
    expect(ownerOfSlot([brian, carla], undefined)).toBeNull();
  });

  it('returns null when nobody claims the slot', () => {
    expect(ownerOfSlot([brian, carla], 7)).toBeNull();
  });

  it('returns null when two users claim the same slot (config error)', () => {
    const dup: UserConfig = { ...carla, name: 'Dup', slug: 'dup', beurer_user_index: 1 };
    expect(ownerOfSlot([brian, dup], 1)).toBeNull();
  });

  it('ignores users with no beurer_user_index', () => {
    expect(ownerOfSlot([brian, unslotted], 1)).toBe(brian);
  });
});
