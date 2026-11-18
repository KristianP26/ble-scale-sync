import { describe, it, expect } from 'vitest';
import { freshAdapter, replaySession } from './session.js';
import type { Trace } from './trace.js';
import { session as uc352 } from '../../fixtures/and-d/uc352ble.js';

describe('replaySession timeZone', () => {
  // The A&D app wrote 08:42:36 local in a zone two hours east of UTC; the
  // adapter writes the host's local time the same way (#408).
  const trace = uc352.traces['connection-1'];
  const now = Date.UTC(2026, 7, 22, 6, 42, 36);
  const timeWrite = (r: Awaited<ReturnType<typeof replaySession>>): string | undefined =>
    r.writes.find((w) => w.uuid === '2a08')?.hex;

  it('runs the session in the given zone', async () => {
    const r = await replaySession(freshAdapter(uc352), trace, {
      now,
      timeZone: 'Europe/Bratislava',
    });
    expect(timeWrite(r)).toBe('ea070816082a24');
  });

  it("runs in the suite's zone without one, and gives the zone back after", async () => {
    const before = process.env.TZ;
    await replaySession(freshAdapter(uc352), trace, { now, timeZone: 'Europe/Bratislava' });
    expect(process.env.TZ).toBe(before);
    const r = await replaySession(freshAdapter(uc352), trace, { now });
    expect(timeWrite(r)).toBe('ea070816062a24');
  });

  it('gives the zone back when the replay throws', async () => {
    const before = process.env.TZ;
    const broken = { ...trace, steps: undefined } as unknown as Trace;
    await expect(
      replaySession(freshAdapter(uc352), broken, { now, timeZone: 'Asia/Tokyo' }),
    ).rejects.toThrow();
    expect(process.env.TZ).toBe(before);
  });
});
