import { describe, it, expect, vi } from 'vitest';

/**
 * A-02: in continuous mode the loop calls `source.stop()` on its way out, and
 * PollReadingSource had no stop at all. A SIGTERM or a watchdog trip during an
 * idle cycle (the most common state) therefore left the node-ble D-Bus socket
 * open, and every shutdown ended through the force-exit timer instead of the
 * event loop draining.
 */

const scanAndReadRaw = vi.fn();
const releaseTransport = vi.fn(async () => {});
vi.mock('../../src/ble/index.js', () => ({ scanAndReadRaw, releaseTransport }));

vi.mock('../../src/config/resolve.js', () => ({
  resolveUserProfile: () => ({ sex: 'male', age: 40, heightCm: 180, athlete: false }),
}));

const { PollReadingSource } = await import('../../src/runtime/poll-source.js');
import type { ReadingSource } from '../../src/runtime/loop.js';

type Ctx = ConstructorParameters<typeof PollReadingSource>[0];

describe('PollReadingSource.stop (A-02)', () => {
  it('releases the BLE transport of the configured handler', async () => {
    const ctx = { config: { users: [{}], scale: {} }, bleHandler: 'auto' } as unknown as Ctx;
    const source: ReadingSource = new PollReadingSource(ctx, []);

    await source.stop?.();

    expect(releaseTransport).toHaveBeenCalledTimes(1);
    expect(releaseTransport).toHaveBeenCalledWith('auto');
  });
});
