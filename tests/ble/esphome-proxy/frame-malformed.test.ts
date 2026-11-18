import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  _internals,
  MAX_PLAINTEXT_BUFFER_BYTES,
} from '../../../src/ble/handler-esphome-proxy/client.js';

const nodeRequire = createRequire(import.meta.url);

/**
 * What a corrupt or broken ESPHome peer can do through the frame helpers of
 * `@2colors/esphome-native-api`, against the REAL library (like frame-patch.test.ts):
 * a corrupt frame ends up as an `error` event and never as an exception in the
 * process, and the plaintext helper no longer buffers without a limit (ADR D108).
 */
const UTILS = '@2colors/esphome-native-api/lib/utils';
const Plaintext = nodeRequire(`${UTILS}/plaintextFrameHelper.js`);
const Noise = nodeRequire(`${UTILS}/noiseFrameHelper.js`);

// Both patches mutate the real prototypes for this process, as in production.
_internals.patchUnknownMessageHandling();
_internals.patchPlaintextBufferCap();

function plaintextHelper() {
  const helper = new Plaintext('127.0.0.1', 1);
  const errors: Error[] = [];
  helper.on('error', (e: Error) => errors.push(e));
  return { helper, errors };
}

describe('ESPHome frame helpers against malformed input', () => {
  it('a plaintext frame with a bad first byte is an error event, not an exception', () => {
    const { helper, errors } = plaintextHelper();
    expect(() => helper.onData(Buffer.from([0x05, 0x01, 0x01, 0x00]))).not.toThrow();
    expect(errors).toHaveLength(1);
    helper.socket.destroy();
  });

  it('a known message id with a corrupt payload is an error event, not an exception', () => {
    const { helper, errors } = plaintextHelper();
    // type 0, length 4, id 1 (HelloRequest), then bytes that are not a valid message.
    expect(() =>
      helper.onData(Buffer.from([0x00, 0x04, 0x01, 0xff, 0xff, 0xff, 0xff])),
    ).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);
    helper.socket.destroy();
  });

  it('a Noise frame with a bad indicator is an error event, not an exception', () => {
    const helper = new Noise('127.0.0.1', 1, Buffer.alloc(32).toString('base64'), '');
    const errors: Error[] = [];
    helper.on('error', (e: Error) => errors.push(e));
    expect(() => helper.onData(Buffer.from([0x07, 0x00, 0x01, 0x00]))).not.toThrow();
    expect(errors).toHaveLength(1);
    helper.socket.destroy();
  });
});

describe('plaintext buffer cap', () => {
  it('closes the connection instead of buffering past the cap', () => {
    const { helper, errors } = plaintextHelper();
    // Header declaring a 2 GiB message of id 1, then data far past the cap.
    helper.onData(Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0x07, 0x01]));
    const chunk = Buffer.alloc(256 * 1024, 0x41);
    for (let i = 0; i < 8; i++) helper.onData(chunk);
    expect(helper.buffer.length).toBeLessThanOrEqual(MAX_PLAINTEXT_BUFFER_BYTES);
    expect(errors.filter((e) => /passed \d+ bytes/.test(e.message))).toHaveLength(1);
    expect(helper.socket.destroyed).toBe(true);
  });

  it('leaves an ordinary stream alone', () => {
    const { helper, errors } = plaintextHelper();
    const msg = Buffer.from([0x00, 0x00, 0x01]); // HelloRequest, empty body
    expect(() => helper.onData(msg)).not.toThrow();
    expect(errors).toHaveLength(0);
    expect(helper.socket.destroyed).toBe(false);
    helper.socket.destroy();
  });

  it('is skipped with a warning when the library internals are not as expected', async () => {
    const saved = Plaintext.prototype.onData;
    // Not a function: the contract check fails, nothing is wrapped.
    Plaintext.prototype.onData = undefined;
    vi.resetModules();
    const { bleLog: freshLog } = await import('../../../src/ble/types.js');
    const warn = vi.spyOn(freshLog, 'warn').mockImplementation(() => {});
    try {
      const fresh = await import('../../../src/ble/handler-esphome-proxy/client.js');
      fresh._internals.patchPlaintextBufferCap();
      expect(Plaintext.prototype.onData).toBeUndefined();
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('plaintext buffer cap skipped')),
      ).toBe(true);
    } finally {
      Plaintext.prototype.onData = saved;
      warn.mockRestore();
    }
  });
});
