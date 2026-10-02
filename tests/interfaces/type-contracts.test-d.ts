import { describe, it, expect } from 'vitest';

import type {
  ScaleAdapter,
  ScaleAdapterCore,
  ScaleReading,
} from '../../src/interfaces/scale-adapter.js';
import type { ConfigFieldDef } from '../../src/interfaces/exporter-schema.js';
import type { ExportResult, ExportResultDetail } from '../../src/interfaces/exporter.js';

/**
 * Compile-time contracts, guarded by `@ts-expect-error`.
 *
 * These assert things Vitest cannot: each marked line MUST be a type error. If
 * a constraint is later loosened, the error disappears, the directive becomes
 * unused, and `tsc --noEmit` fails with "Unused '@ts-expect-error' directive" -
 * so relaxing one of these cannot pass CI unnoticed. The runtime assertions
 * below exist only so the file is a real test and the types are referenced.
 */

// A real (empty) object, not `declare const`: these probes spread it, and a
// declared-only binding does not exist at runtime. The cast keeps the TYPE
// exact, which is all the assertions below depend on.
const core = {} as unknown as ScaleAdapterCore;

describe('ScaleAdapter capability pairings', () => {
  it('rejects an unlock interval with no command to write', () => {
    // A timer that fires forever and writes nothing. `Partial<Unlockable>` made
    // every member independently optional, so this used to type-check.
    // @ts-expect-error unlockIntervalMs requires unlockCommand
    const bad: ScaleAdapter = { ...core, unlockIntervalMs: 1000 };
    expect(bad).toBeDefined();
  });

  it('rejects preferPassive with neither broadcast parser', () => {
    // BroadcastSource's own doc says "Adapters that set this must implement
    // parseServiceData or parseBroadcast". It was a sentence, not a type: this
    // describes an adapter that refuses GATT and cannot read an advertisement
    // either, so it can never produce a reading.
    // @ts-expect-error preferPassive: true requires a parser
    const bad: ScaleAdapter = { ...core, preferPassive: true };
    expect(bad).toBeDefined();
  });

  it('still accepts the valid pairings', () => {
    const unlock: ScaleAdapter = { ...core, unlockCommand: [0x01], unlockIntervalMs: 1000 };
    const passive: ScaleAdapter = {
      ...core,
      preferPassive: true,
      parseBroadcast: (_d: Buffer): ScaleReading | null => null,
    };
    const neither: ScaleAdapter = { ...core };
    expect([unlock, passive, neither]).toHaveLength(3);
  });
});

describe('ConfigFieldDef ties a field kind to its values', () => {
  it('rejects a default of the wrong kind', () => {
    // @ts-expect-error a number field cannot default to a string
    const bad: ConfigFieldDef = {
      key: 'timeout',
      label: 'Timeout',
      type: 'number',
      required: false,
      default: 'abc',
    };
    expect(bad).toBeDefined();
  });

  it('rejects a select with nothing to select', () => {
    // promptField() answers this by returning field.default - undefined for a
    // required field - so `required` enforced nothing on that path.
    //
    // The directive sits on the PROPERTY, not on the declaration: TypeScript
    // reports the tuple-length error here at `choices`, and a directive
    // one line above `const` covers only that line - which Prettier had already
    // moved away from the error once.
    const bad: ConfigFieldDef = {
      key: 'mode',
      label: 'Mode',
      type: 'select',
      required: true,
      // @ts-expect-error a select needs at least one choice
      choices: [],
    };
    expect(bad).toBeDefined();
  });

  it('still accepts well-formed fields', () => {
    const num: ConfigFieldDef = {
      key: 't',
      label: 'T',
      type: 'number',
      required: false,
      default: 10,
    };
    const sel: ConfigFieldDef = {
      key: 'm',
      label: 'M',
      type: 'select',
      required: true,
      choices: [{ label: 'CSV', value: 'csv' }],
    };
    expect([num, sel]).toHaveLength(2);
  });
});

describe('an export result cannot be half a result', () => {
  it('rejects a failure with no reason', () => {
    // @ts-expect-error a failed export must say why
    const bad: ExportResult = { success: false };
    expect(bad).toBeDefined();
  });

  it('rejects a success carrying an error', () => {
    // @ts-expect-error a successful export has no error
    const bad: ExportResult = { success: true, error: 'but it worked?' };
    expect(bad).toBeDefined();
  });

  it('rejects a failed detail with no reason', () => {
    // @ts-expect-error a failed detail must say why
    const bad: ExportResultDetail = { name: 'garmin', ok: false };
    expect(bad).toBeDefined();
  });

  it('still accepts both honest shapes', () => {
    const ok: ExportResult = { success: true };
    const failed: ExportResult = { success: false, error: 'HTTP 500' };
    expect([ok, failed]).toHaveLength(2);
  });
});
