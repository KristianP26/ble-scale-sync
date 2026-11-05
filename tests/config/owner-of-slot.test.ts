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

const alice: UserConfig = { ...base, name: 'Alice', slug: 'alice', beurer_user_index: 1 };
const bob: UserConfig = { ...base, name: 'Bob', slug: 'bob', beurer_user_index: 2 };
const unslotted: UserConfig = { ...base, name: 'Guest', slug: 'guest' };

describe('ownerOfSlot', () => {
  it('returns the single user who claims the slot', () => {
    expect(ownerOfSlot([alice, bob], 2)).toBe(bob);
  });

  it('returns null when the frame names no slot', () => {
    expect(ownerOfSlot([alice, bob], undefined)).toBeNull();
  });

  it('returns null when nobody claims the slot', () => {
    expect(ownerOfSlot([alice, bob], 7)).toBeNull();
  });

  it('returns null when two users claim the same slot (config error)', () => {
    const dup: UserConfig = { ...bob, name: 'Dup', slug: 'dup', beurer_user_index: 1 };
    expect(ownerOfSlot([alice, dup], 1)).toBeNull();
  });

  it('ignores users with no beurer_user_index', () => {
    expect(ownerOfSlot([alice, unslotted], 1)).toBe(alice);
  });
});
