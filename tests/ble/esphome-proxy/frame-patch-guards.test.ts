import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

const FRAME_HELPER = '@2colors/esphome-native-api/lib/utils/frameHelper.js';
const MESSAGES = '@2colors/esphome-native-api/lib/utils/messages.js';

/**
 * B-12: the #252 `buildMessage` patch against the D012 contract, on the REAL
 * library module (same require cache the production code resolves). Each test
 * re-imports client.ts so its one-shot guard starts clear, alters the library
 * the way a future release could, and restores it afterwards.
 */
async function freshPatch(): Promise<void> {
  vi.resetModules();
  const { _internals } = await import('../../../src/ble/handler-esphome-proxy/client.js');
  _internals.patchUnknownMessageHandling();
}

describe('ESPHome buildMessage patch guards (B-12, D012)', () => {
  it('leaves a library that already ignores unknown ids alone', async () => {
    const FrameHelper = nodeRequire(FRAME_HELPER);
    const saved = FrameHelper.prototype.buildMessage;
    // What a fixed upstream would look like: an unknown id neither ends the
    // connection nor hands back undefined.
    const fixed = function (this: { end: () => void }, id: number): unknown {
      return id === 1 ? {} : { toObject: () => ({}) };
    };
    FrameHelper.prototype.buildMessage = fixed;
    try {
      await freshPatch();
      expect(FrameHelper.prototype.buildMessage).toBe(fixed);
    } finally {
      FrameHelper.prototype.buildMessage = saved;
    }
  });

  it('does not install itself when the id table it depends on is gone', async () => {
    const FrameHelper = nodeRequire(FRAME_HELPER);
    const messages = nodeRequire(MESSAGES);
    const savedProto = FrameHelper.prototype.buildMessage;
    const savedTable = messages.id_to_type;
    // A rename like this keeps buildMessage but would make the patched version
    // throw a TypeError on EVERY frame, so the proxy would decode nothing.
    delete messages.id_to_type;
    messages.idToType = savedTable;
    try {
      const before = FrameHelper.prototype.buildMessage;
      await freshPatch();
      expect(FrameHelper.prototype.buildMessage).toBe(before);
    } finally {
      messages.id_to_type = savedTable;
      delete messages.idToType;
      FrameHelper.prototype.buildMessage = savedProto;
    }
  });
});
