import { describe, it, expect } from 'vitest';
import {
  tagBleFailure,
  bleFailureKind,
  shouldCountAsWatchdogFailure,
} from '../../src/ble/failure-kind.js';

describe('failure-kind', () => {
  it('tags an error and reads the kind back', () => {
    const err = tagBleFailure(new Error('not found'), 'idle');
    expect(bleFailureKind(err)).toBe('idle');
  });

  it('is idempotent: never overwrites an existing tag', () => {
    const err = tagBleFailure(new Error('x'), 'idle');
    tagBleFailure(err, 'wedge-suspect');
    expect(bleFailureKind(err)).toBe('idle');
  });

  it('returns undefined for untagged errors and non-objects', () => {
    expect(bleFailureKind(new Error('plain'))).toBeUndefined();
    expect(bleFailureKind('string error')).toBeUndefined();
    expect(bleFailureKind(null)).toBeUndefined();
  });

  it('counts everything except an explicit idle tag', () => {
    expect(shouldCountAsWatchdogFailure(tagBleFailure(new Error(), 'idle'))).toBe(false);
    expect(shouldCountAsWatchdogFailure(tagBleFailure(new Error(), 'wedge-suspect'))).toBe(true);
    expect(shouldCountAsWatchdogFailure(new Error('untagged'))).toBe(true);
    expect(shouldCountAsWatchdogFailure('string')).toBe(true);
  });
});
