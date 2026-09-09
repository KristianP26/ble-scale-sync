import { createLogger } from '../logger.js';
import type { UserConfig, UnknownUserStrategy } from './schema.js';

const log = createLogger('UserMatch');

// --- Types ---

export interface MatchResult {
  user: UserConfig | null;
  tier: 'exact' | 'tiebreak' | 'last_known' | 'strategy';
  warning?: string;
}

// --- Helpers ---

function inRange(weight: number, user: UserConfig): boolean {
  return weight >= user.weight_range.min && weight <= user.weight_range.max;
}

/**
 * True when a weight falls outside a user's configured range.
 *
 * Exported so the processor's `out_of_range` guard and the matcher share ONE
 * definition of the boundary. Both ends are inclusive, matching `inRange`
 * above: a weight exactly on `min` or `max` is in range (#395).
 */
export function isOutOfRange(user: UserConfig, weight: number): boolean {
  return !inRange(weight, user);
}

function rangeMidpoint(user: UserConfig): number {
  return (user.weight_range.min + user.weight_range.max) / 2;
}

// --- Weight drift detection ---

/**
 * Warn if a measurement falls in the outer 10% of a user's weight range.
 * Returns a warning string, or null if the weight is in the safe zone.
 */
export function detectWeightDrift(user: UserConfig, weight: number): string | null {
  const { min, max } = user.weight_range;
  const span = max - min;
  const threshold = span * 0.1;

  if (weight < min || weight > max) {
    return `Weight ${weight} kg is outside ${user.name}'s range [${min}–${max}]`;
  }

  if (weight < min + threshold) {
    return `Weight ${weight} kg is near the lower boundary of ${user.name}'s range [${min}–${max}]`;
  }

  if (weight > max - threshold) {
    return `Weight ${weight} kg is near the upper boundary of ${user.name}'s range [${min}–${max}]`;
  }

  return null;
}

// --- Main matching ---

/**
 * Match a weight measurement to a user using 4-tier priority:
 *
 * 1. Single user → always match (warn if out of range)
 * 2. Exact range match (one user) → return
 * 3. Multiple range matches → tiebreak by last_known_weight proximity, fallback config order
 * 4. No range match + has last_known_weight → closest
 * 5. No match → apply unknown_user strategy
 */
export function matchUserByWeight(
  users: UserConfig[],
  weight: number,
  strategy: UnknownUserStrategy,
): MatchResult {
  // Edge case: no users
  if (users.length === 0) {
    return { user: null, tier: 'strategy', warning: 'No users configured' };
  }

  // Tier 1: single user — always match
  if (users.length === 1) {
    const user = users[0];
    const warning = !inRange(weight, user)
      ? `Weight ${weight} kg is outside ${user.name}'s range [${user.weight_range.min}–${user.weight_range.max}]`
      : undefined;
    if (warning) log.warn(warning);
    return { user, tier: 'exact', warning };
  }

  // Tier 2/3: find users whose range includes the weight
  const rangeMatches = users.filter((u) => inRange(weight, u));

  if (rangeMatches.length === 1) {
    // Tier 2: exact single match
    return { user: rangeMatches[0], tier: 'exact' };
  }

  if (rangeMatches.length > 1) {
    // Tier 3: multiple range matches — tiebreak by last_known_weight proximity
    const withLastKnown = rangeMatches.filter((u) => u.last_known_weight !== null);

    if (withLastKnown.length > 0) {
      withLastKnown.sort(
        (a, b) => Math.abs(weight - a.last_known_weight!) - Math.abs(weight - b.last_known_weight!),
      );
      const best = withLastKnown[0];
      log.info(`Multiple range matches — resolved to ${best.name} by last_known_weight proximity`);
      return { user: best, tier: 'tiebreak' };
    }

    // No last_known_weight — fall back to config order
    const first = rangeMatches[0];
    const warning = `Multiple range matches for ${weight} kg — using ${first.name} (config order)`;
    log.warn(warning);
    return { user: first, tier: 'tiebreak', warning };
  }

  // Tier 4: no range match — try last_known_weight
  const withLastKnown = users.filter((u) => u.last_known_weight !== null);
  if (withLastKnown.length > 0) {
    withLastKnown.sort(
      (a, b) => Math.abs(weight - a.last_known_weight!) - Math.abs(weight - b.last_known_weight!),
    );
    const best = withLastKnown[0];
    const warning = `No range match for ${weight} kg — matched ${best.name} by last_known_weight`;
    log.warn(warning);
    return { user: best, tier: 'last_known', warning };
  }

  // Tier 5: apply unknown_user strategy
  switch (strategy) {
    case 'nearest': {
      // Closest to range midpoint
      const sorted = [...users].sort(
        (a, b) => Math.abs(weight - rangeMidpoint(a)) - Math.abs(weight - rangeMidpoint(b)),
      );
      const best = sorted[0];
      const warning = `No match for ${weight} kg — nearest user ${best.name} (midpoint ${rangeMidpoint(best)} kg)`;
      log.warn(warning);
      return { user: best, tier: 'strategy', warning };
    }

    case 'log': {
      const warning = `No match for ${weight} kg — logging and skipping (unknown_user: log)`;
      log.warn(warning);
      return { user: null, tier: 'strategy', warning };
    }

    case 'ignore':
      return { user: null, tier: 'strategy' };
  }
}
