import { describe, it, expect } from 'vitest';
import {
  matchUserByWeight,
  detectWeightDrift,
  isOutOfRange,
} from '../../src/config/user-matching.js';
import type { UserConfig } from '../../src/config/schema.js';

// --- Test data ---

function makeUser(overrides: Partial<UserConfig> & { name: string }): UserConfig {
  return {
    slug: overrides.name.toLowerCase().replace(/\s+/g, '-'),
    height: 175,
    birth_date: '1990-01-01',
    gender: 'male',
    is_athlete: false,
    weight_range: { min: 60, max: 90 },
    last_known_weight: null,
    ...overrides,
  };
}

const ALICE = makeUser({ name: 'Alice', weight_range: { min: 50, max: 70 } });
const BOB = makeUser({ name: 'Bob', weight_range: { min: 75, max: 100 } });
const CHARLIE = makeUser({ name: 'Charlie', weight_range: { min: 65, max: 85 } });

// --- matchUserByWeight ---

describe('matchUserByWeight', () => {
  describe('single user', () => {
    it('matches the only user when weight is in range', () => {
      const result = matchUserByWeight([ALICE], 60, 'nearest');
      expect(result.user).toBe(ALICE);
      expect(result.tier).toBe('exact');
      expect(result.warning).toBeUndefined();
    });

    it('still matches when weight is out of range (with warning)', () => {
      const result = matchUserByWeight([ALICE], 120, 'nearest');
      expect(result.user).toBe(ALICE);
      expect(result.tier).toBe('exact');
      expect(result.warning).toContain('outside');
      expect(result.warning).toContain('120');
    });
  });

  describe('multiple users — no overlap', () => {
    it('matches the correct user by range', () => {
      const result = matchUserByWeight([ALICE, BOB], 65, 'nearest');
      expect(result.user).toBe(ALICE);
      expect(result.tier).toBe('exact');
    });

    it('matches second user when weight falls in their range', () => {
      const result = matchUserByWeight([ALICE, BOB], 85, 'nearest');
      expect(result.user).toBe(BOB);
      expect(result.tier).toBe('exact');
    });
  });

  describe('overlapping ranges', () => {
    it('resolves tiebreak by last_known_weight proximity', () => {
      // Alice: 50-70, Charlie: 65-85, overlap at 65-70
      const aliceWithLkw = { ...ALICE, last_known_weight: 55 };
      const charlieWithLkw = { ...CHARLIE, last_known_weight: 68 };

      const result = matchUserByWeight([aliceWithLkw, charlieWithLkw], 67, 'nearest');
      expect(result.user?.name).toBe('Charlie');
      expect(result.tier).toBe('tiebreak');
    });

    it('falls back to config order when no last_known_weight', () => {
      // Both Alice and Charlie match at 67
      const result = matchUserByWeight([ALICE, CHARLIE], 67, 'nearest');
      expect(result.user).toBe(ALICE);
      expect(result.tier).toBe('tiebreak');
      expect(result.warning).toContain('config order');
    });

    it('prefers user with last_known_weight over one without', () => {
      const charlieWithLkw = { ...CHARLIE, last_known_weight: 80 };
      const result = matchUserByWeight([ALICE, charlieWithLkw], 67, 'nearest');
      // Only charlieWithLkw has last_known_weight among range matches
      expect(result.user?.name).toBe('Charlie');
      expect(result.tier).toBe('tiebreak');
    });
  });

  describe('no range match — last_known_weight fallback', () => {
    it('matches closest by last_known_weight', () => {
      const aliceWithLkw = { ...ALICE, last_known_weight: 55 };
      const bobWithLkw = { ...BOB, last_known_weight: 95 };

      // Weight 72 is outside both ranges, Bob's LKW is further away
      const result = matchUserByWeight([aliceWithLkw, bobWithLkw], 72, 'nearest');
      expect(result.user?.name).toBe('Alice');
      expect(result.tier).toBe('last_known');
      expect(result.warning).toContain('last_known_weight');
    });
  });

  describe('unknown_user strategies', () => {
    it('nearest: picks user with closest midpoint', () => {
      // Alice midpoint: 60, Bob midpoint: 87.5
      // Weight 72 is between ranges, closer to Alice's midpoint
      const result = matchUserByWeight([ALICE, BOB], 72, 'nearest');
      expect(result.user?.name).toBe('Alice');
      expect(result.tier).toBe('strategy');
      expect(result.warning).toContain('nearest');
    });

    it('log: returns null with warning', () => {
      const result = matchUserByWeight([ALICE, BOB], 72, 'log');
      expect(result.user).toBeNull();
      expect(result.tier).toBe('strategy');
      expect(result.warning).toContain('logging and skipping');
    });

    it('ignore: returns null without warning', () => {
      const result = matchUserByWeight([ALICE, BOB], 72, 'ignore');
      expect(result.user).toBeNull();
      expect(result.tier).toBe('strategy');
      expect(result.warning).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('empty users array returns null', () => {
      const result = matchUserByWeight([], 75, 'nearest');
      expect(result.user).toBeNull();
      expect(result.tier).toBe('strategy');
      expect(result.warning).toContain('No users');
    });

    it('exactly on boundary is in range', () => {
      const result = matchUserByWeight([ALICE, BOB], 70, 'nearest');
      expect(result.user).toBe(ALICE);
      expect(result.tier).toBe('exact');
    });

    it('exactly on lower boundary is in range', () => {
      const result = matchUserByWeight([ALICE, BOB], 50, 'nearest');
      expect(result.user).toBe(ALICE);
      expect(result.tier).toBe('exact');
    });

    it('exactly on upper boundary of Bob is in range', () => {
      const result = matchUserByWeight([ALICE, BOB], 100, 'nearest');
      expect(result.user).toBe(BOB);
      expect(result.tier).toBe('exact');
    });
  });
});

// --- detectWeightDrift ---

describe('detectWeightDrift', () => {
  // Alice: 50-70, span 20, threshold 2
  it('returns null when weight is in safe zone', () => {
    expect(detectWeightDrift(ALICE, 60)).toBeNull();
  });

  it('warns near lower boundary', () => {
    const warning = detectWeightDrift(ALICE, 51);
    expect(warning).toContain('near the lower boundary');
    expect(warning).toContain('Alice');
  });

  it('warns near upper boundary', () => {
    const warning = detectWeightDrift(ALICE, 69);
    expect(warning).toContain('near the upper boundary');
    expect(warning).toContain('Alice');
  });

  it('warns when outside range (below)', () => {
    const warning = detectWeightDrift(ALICE, 45);
    expect(warning).toContain('outside');
  });

  it('warns when outside range (above)', () => {
    const warning = detectWeightDrift(ALICE, 75);
    expect(warning).toContain('outside');
  });

  it('returns null exactly at the safe zone threshold', () => {
    // threshold = 2, so min+threshold = 52 is in safe zone
    expect(detectWeightDrift(ALICE, 52)).toBeNull();
    // max-threshold = 68 is in safe zone
    expect(detectWeightDrift(ALICE, 68)).toBeNull();
  });
});

// --- isOutOfRange ---

/**
 * Pins the exported predicate the processor's out_of_range guard shares with
 * the matcher (#395). Both ends inclusive, so the boundary itself is IN range
 * and a reading exactly on a user's limit is never discarded.
 */
describe('isOutOfRange', () => {
  it('treats both ends of the range as inside it', () => {
    expect(isOutOfRange(ALICE, 50)).toBe(false);
    expect(isOutOfRange(ALICE, 70)).toBe(false);
  });

  it('is true just outside either end', () => {
    expect(isOutOfRange(ALICE, 49.9)).toBe(true);
    expect(isOutOfRange(ALICE, 70.1)).toBe(true);
  });
});
