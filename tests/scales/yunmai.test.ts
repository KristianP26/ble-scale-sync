import { describe, it, expect } from 'vitest';
import { YunmaiScaleAdapter } from '../../src/scales/yunmai.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new YunmaiScaleAdapter();
}

function makeFrame(opts: {
  protocolVer?: number;
  respType?: number;
  weightRaw?: number;
  impedanceRaw?: number;
  fatRaw?: number;
  length?: number;
}): Buffer {
  const len = opts.length ?? 19;
  const buf = Buffer.alloc(len);
  buf[0] = 0x0d; // marker
  buf[1] = opts.protocolVer ?? 0x1e; // protocol version
  buf[2] = 0x00;
  buf[3] = opts.respType ?? 0x02; // final frame
  // bytes 4: padding
  // bytes 5-8: timestamp (zeroed)
  // bytes 9-12: user id (zeroed)
  buf.writeUInt16BE(opts.weightRaw ?? 8000, 13); // 8000/100=80 kg
  if (len >= 17) {
    buf.writeUInt16BE(opts.impedanceRaw ?? 500, 15);
  }
  if (len >= 19) {
    buf.writeUInt16BE(opts.fatRaw ?? 2200, 17); // 2200/100=22%
  }
  return buf;
}

describe('YunmaiScaleAdapter', () => {
  describe('matches()', () => {
    it('matches "Yunmai" name', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Yunmai Standard', []);
      expect(adapter.matches(p)).toBe(true);
    });

    it('matches case-insensitively', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('YUNMAI', []);
      expect(adapter.matches(p)).toBe(true);
    });

    it('detects Mini variant via ISM in name', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Yunmai ISM', []);
      adapter.matches(p);
      // isMini should be set — we test this via isComplete behavior
    });

    it('detects SE variant via ISSE in name', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Yunmai ISSE', []);
      adapter.matches(p);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('QN-Scale', []);
      expect(adapter.matches(p)).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses final frame with weight', () => {
      const adapter = makeAdapter();
      // Standard variant (no ISM in name) — match first
      adapter.matches(mockPeripheral('Yunmai Standard', []));

      const buf = makeFrame({ weightRaw: 8000 });
      const reading = adapter.parseNotification(buf);

      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(0); // standard variant: no impedance
    });

    it('parses Mini variant with impedance', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []));

      const buf = makeFrame({ weightRaw: 8000, impedanceRaw: 480 });
      const reading = adapter.parseNotification(buf);

      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(480);
    });

    it('parses embedded fat percent for protocol >= 0x1E', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []));

      const buf = makeFrame({ protocolVer: 0x1e, fatRaw: 2500 }); // 25%
      adapter.parseNotification(buf);
      // The embedded fat is used in computeMetrics, not returned in reading
    });

    it('returns null for non-final frame (respType != 0x02)', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []));

      const buf = makeFrame({ respType: 0x01 }); // measuring, not final
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(10))).toBeNull();
    });

    it('returns null for zero weight', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai Standard', []));
      const buf = makeFrame({ weightRaw: 0 });
      expect(adapter.parseNotification(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('Standard variant: complete when weight > 0', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai Standard', []));
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('Standard variant: incomplete when weight = 0', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai Standard', []));
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });

    it('Mini variant: complete on weight (impedance preferred via hold, not required)', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []));
      // #257: a weight-only final frame is complete so a unit that never reports
      // impedance resolves weight-only instead of hanging until the read timeout.
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
      expect(adapter.isComplete({ weight: 80, impedance: 500 })).toBe(true);
    });
  });

  describe('completion hold (#257)', () => {
    it('Mini/SE variant arms a hold window so impedance can arrive', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISSE', []));
      expect(adapter.completionHoldMs).toBeGreaterThan(0);
    });

    it('Standard variant sets no hold (resolves immediately)', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai Standard', []));
      expect(adapter.completionHoldMs).toBeUndefined();
    });

    it('isFinal resolves immediately once impedance is present', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISSE', []));
      expect(adapter.isFinal({ weight: 80, impedance: 500 })).toBe(true);
      expect(adapter.isFinal({ weight: 80, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid payload for standard variant (no impedance)', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai Standard', []));

      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 0 }, profile);

      expect(payload.weight).toBe(80);
      assertPayloadRanges(payload);
    });

    it('returns valid payload for Mini variant with impedance', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []));

      // Parse a frame to set embedded fat
      const buf = makeFrame({ protocolVer: 0x1e, fatRaw: 2200, impedanceRaw: 500 });
      adapter.parseNotification(buf);

      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);

      expect(payload.weight).toBe(80);
      expect(payload.impedance).toBe(500);
      assertPayloadRanges(payload);
    });

    it('uses embedded fat percent when available', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []));

      // Parse with embedded fat = 22%
      const buf = makeFrame({ protocolVer: 0x1e, fatRaw: 2200, impedanceRaw: 500 });
      adapter.parseNotification(buf);

      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);

      // The embedded fat (22%) should be used
      expect(payload.bodyFatPercent).toBeCloseTo(22, 0);
    });
  });
});

// #394: adapters are shared singletons and computeMetrics() runs LATER than the
// parse that produced the reading. On the mqtt-proxy and esphome-proxy watchers
// the loop awaits processReading() - network exports included - while the
// watcher is free to open the NEXT session, so onSessionStart() for session N+1
// can land BEFORE computeMetrics() for session N. Reading the live cache there
// hands the completed reading somebody else's composition.
//
// Each test below interleaves the two in exactly that order. Asserting only on
// the payload of an uninterrupted session would pass with or without the fix.

describe('YunmaiScaleAdapter session boundary (#394)', () => {
  function miniAdapter() {
    const a = makeAdapter();
    // isMini gates the embedded fat read; latched from the advertised name.
    a.matches({ localName: 'YUNMAI-ISM', serviceUuids: [] });
    return a;
  }

  it('keeps the completed reading embedded fat when the NEXT session starts first', () => {
    const a = miniAdapter();
    // impedanceRaw 0 so the embedded fat is the ONLY source of 22 %. With the
    // frame default impedance the BIA branch lands near 22 % on its own and the
    // test would pass whether or not the value was pinned.
    const reading = a.parseNotification(makeFrame({ fatRaw: 2200, impedanceRaw: 0 }))!;
    a.onSessionStart();
    const payload = a.computeMetrics(reading, defaultProfile());
    expect(payload.bodyFatPercent).toBeCloseTo(22, 1);
  });

  // ReadingComposition.of() checks has(), not `?? live`. That distinction is the
  // helper's one real subtlety and nothing else exercises it: Yunmai is the only
  // current user whose "no composition" state is ITSELF a value (null), so with
  // a nullish fallback a legitimately-null pin would silently fall through to
  // the live field. Mutating of() to `?? live` leaves the whole suite green
  // except this test.
  it('a pinned null is honoured, not treated as absent', () => {
    const a = miniAdapter();
    // Session N: protocol < 0x1E, so no embedded fat is read and null is pinned.
    const readingN = a.parseNotification(
      makeFrame({ protocolVer: 0x1d, impedanceRaw: 0, weightRaw: 8000 }),
    )!;
    // Session N+1 starts and parses a frame that DOES carry embedded fat,
    // before N's computeMetrics runs - the watcher-transport ordering.
    a.onSessionStart();
    a.parseNotification(makeFrame({ fatRaw: 2200, impedanceRaw: 0 }));

    const payload = a.computeMetrics(readingN, defaultProfile());
    // N must get the estimator, not the next person's 22 %.
    expect(payload.bodyFatPercent).not.toBeCloseTo(22, 1);
  });

  it('does not hand a hand-built reading the previous session embedded fat', () => {
    const a = miniAdapter();
    a.parseNotification(makeFrame({ fatRaw: 2200 }));
    a.onSessionStart();
    // Impedance 0 and no pinned value: must fall through to the estimator, not
    // to the 22 % the previous weigh-in left behind.
    const payload = a.computeMetrics({ weight: 80, impedance: 0 }, defaultProfile());
    expect(payload.bodyFatPercent).not.toBeCloseTo(22, 1);
  });
});

describe('Yunmai variant flag, and what it cannot do yet (#406)', () => {
  it('tracks the last Yunmai-named device, which is not always the one being read', () => {
    const adapter = makeAdapter();
    expect(adapter.matches(mockPeripheral('YUNMAI-ISM', []))).toBe(true);
    expect(
      adapter.parseNotification(makeFrame({ weightRaw: 8000, impedanceRaw: 500 }))!.impedance,
    ).toBe(500);

    // A second Yunmai in range, without the marker, moves the flag. This is
    // the known limitation: fixing it needs per-device state resolved when the
    // session opens, and the adapter contract does not currently give this
    // adapter the device address without giving up unlockCommand.
    expect(adapter.matches(mockPeripheral('Yunmai Standard', []))).toBe(true);
    expect(
      adapter.parseNotification(makeFrame({ weightRaw: 8000, impedanceRaw: 500 }))!.impedance,
    ).toBe(0);
  });

  it('does not latch the Mini behaviour onto a standard unit', () => {
    // The opposite failure, which a sticky flag would introduce: a standard
    // unit inheriting the 4 s completion hold and having [15..16] read as an
    // impedance nobody has captured.
    const adapter = makeAdapter();
    adapter.matches(mockPeripheral('YUNMAI-ISM', []));
    adapter.matches(mockPeripheral('Yunmai Standard', []));
    expect(adapter.completionHoldMs).toBeUndefined();
  });
});
