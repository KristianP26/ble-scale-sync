import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';

/**
 * Guards the runtime repair of dbus-next's match-rule refcounting (#396).
 *
 * This loads the REAL dbus-next internals on purpose, the same way the ESPHome
 * frame-patch test does: if a future dependency bump moves `_addMatch`, renames
 * `lib/bus.js`, or fixes the defect upstream, this file fails in CI rather than
 * letting the patch silently become a no-op or a duplicate.
 *
 * The defect: both methods call
 * `Object.prototype.hasOwnProperty.call(match, this._matchRules)` with the rule
 * STRING as the receiver, which is always false, so `AddMatch` is re-sent for a
 * rule already held and `RemoveMatch` is never sent at all.
 */

const nodeRequire = createRequire(import.meta.url);

let MessageBus: { prototype: Record<string | symbol, unknown> } | undefined;
try {
  MessageBus = nodeRequire('dbus-next/lib/bus.js') as {
    prototype: Record<string | symbol, unknown>;
  };
} catch {
  // dbus-next is an optionalDependency; a noble-only install skips this file.
  MessageBus = undefined;
}

const RULE = "type='signal',interface='com.example.Proof'";

interface FakeBus {
  _matchRules: Record<string, number>;
  _connection: { stream: { writable: boolean } };
  call(msg: { member?: string }): Promise<unknown>;
  sent: string[];
  _addMatch(match: string): Promise<unknown>;
  _removeMatch(match: string): Promise<unknown>;
}

function fakeBus(writable = true): FakeBus {
  const bus = Object.create(MessageBus!.prototype) as FakeBus;
  bus._matchRules = {};
  bus._connection = { stream: { writable } };
  bus.sent = [];
  bus.call = (msg: { member?: string }) => {
    bus.sent.push(String(msg.member));
    return Promise.resolve();
  };
  return bus;
}

describe.skipIf(!MessageBus)('dbus-next match-rule refcount patch (#396)', () => {
  const original: Record<string, unknown> = {};

  beforeAll(() => {
    original._addMatch = MessageBus!.prototype._addMatch;
    original._removeMatch = MessageBus!.prototype._removeMatch;
  });

  afterAll(() => {
    MessageBus!.prototype._addMatch = original._addMatch;
    MessageBus!.prototype._removeMatch = original._removeMatch;
  });

  it('the shipped dbus-next really is broken (control, run before patching)', async () => {
    const bus = fakeBus();
    await bus._addMatch(RULE);
    await bus._addMatch(RULE);
    await bus._removeMatch(RULE);
    await bus._removeMatch(RULE);

    // Two AddMatch for one rule, and RemoveMatch never sent at all.
    expect(bus.sent).toEqual(['AddMatch', 'AddMatch']);
    expect(bus._matchRules[RULE]).toBe(1);
  });

  it('sends exactly one AddMatch and one RemoveMatch once patched', async () => {
    const { applyDbusMatchRefcountPatch } =
      await import('../../../src/ble/handler-node-ble/dbus-match-patch.js');
    applyDbusMatchRefcountPatch();

    const bus = fakeBus();
    await bus._addMatch(RULE);
    await bus._addMatch(RULE);
    await bus._removeMatch(RULE);
    await bus._removeMatch(RULE);

    expect(bus.sent).toEqual(['AddMatch', 'RemoveMatch']);
    expect(RULE in bus._matchRules).toBe(false);
  });

  it('holds the rule while another holder still wants it', async () => {
    const bus = fakeBus();
    await bus._addMatch(RULE);
    await bus._addMatch(RULE);
    await bus._removeMatch(RULE);

    expect(bus.sent).toEqual(['AddMatch']);
    expect(bus._matchRules[RULE]).toBe(1);
  });

  it('ignores a remove for a rule it never held', async () => {
    const bus = fakeBus();
    await bus._removeMatch(RULE);
    expect(bus.sent).toEqual([]);
  });

  it('does not write to a closed stream', async () => {
    const bus = fakeBus(false);
    await bus._addMatch(RULE);
    await bus._removeMatch(RULE);
    expect(bus.sent).toEqual(['AddMatch']);
  });

  it('is idempotent: a second apply does not stack another layer', async () => {
    const { applyDbusMatchRefcountPatch, _internals } =
      await import('../../../src/ble/handler-node-ble/dbus-match-patch.js');
    const afterFirst = MessageBus!.prototype._addMatch;
    _internals.resetForTest();
    applyDbusMatchRefcountPatch();
    expect(MessageBus!.prototype._addMatch).toBe(afterFirst);

    const bus = fakeBus();
    await bus._addMatch(RULE);
    await bus._removeMatch(RULE);
    expect(bus.sent).toEqual(['AddMatch', 'RemoveMatch']);
  });

  it('marks the prototype, which is what makes a re-apply a no-op', () => {
    expect(MessageBus!.prototype[Symbol.for('ble-scale-sync.dbus-match-refcount-patched')]).toBe(
      true,
    );
  });

  it('declines to patch a dbus-next that already refcounts correctly', async () => {
    const { applyDbusMatchRefcountPatch, _internals } =
      await import('../../../src/ble/handler-node-ble/dbus-match-patch.js');
    // Simulate a future upstream fix: correct source, and no patch marker.
    const upstreamFixed = function (this: unknown, match: string): Promise<unknown> {
      void Object.prototype.hasOwnProperty.call({}, match);
      return Promise.resolve();
    };
    MessageBus!.prototype._addMatch = upstreamFixed;
    MessageBus!.prototype[Symbol.for('ble-scale-sync.dbus-match-refcount-patched')] = false;

    _internals.resetForTest();
    applyDbusMatchRefcountPatch();

    expect(MessageBus!.prototype._addMatch).toBe(upstreamFixed);
  });
});
