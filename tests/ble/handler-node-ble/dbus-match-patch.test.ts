import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

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
const PATCH_MARKER = Symbol.for('ble-scale-sync.dbus-match-refcount-patched');

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
    // The prototype is reached through Node's CJS require cache, which is shared
    // by every test file in this worker. Leaving the marker behind would make
    // the next file's view of "has this been patched" depend on running order.
    delete MessageBus!.prototype[PATCH_MARKER];
  });

  // Asserted against the SHIPPED SOURCE rather than the live prototype: the
  // prototype is shared across this worker, so a control that reads it would
  // pass or fail depending on whether some earlier file had already applied the
  // patch for real.
  it('the shipped dbus-next really is broken (control)', () => {
    const src = readFileSync(nodeRequire.resolve('dbus-next/lib/bus.js'), 'utf-8');
    const bodyOf = (name: string): string => {
      const start = src.indexOf(`${name} (match)`);
      return start === -1 ? '' : src.slice(start, start + 400);
    };
    const add = bodyOf('_addMatch');
    const remove = bodyOf('_removeMatch');
    // The rule string is the receiver and the bookkeeping object is the property
    // name, which is always false.
    expect(add).toMatch(/hasOwnProperty\.call\(\s*match\s*,\s*this\._matchRules\s*\)/);
    expect(remove).toMatch(/hasOwnProperty\.call\(\s*match\s*,\s*this\._matchRules\s*\)/);
  });

  it('and the shipped implementation really does re-add and never remove', async () => {
    const unpatchedAdd = original._addMatch as (this: unknown, m: string) => Promise<unknown>;
    const unpatchedRemove = original._removeMatch as (this: unknown, m: string) => Promise<unknown>;
    const bus = fakeBus();
    await unpatchedAdd.call(bus, RULE);
    await unpatchedAdd.call(bus, RULE);
    await unpatchedRemove.call(bus, RULE);
    await unpatchedRemove.call(bus, RULE);

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
    expect(MessageBus!.prototype[PATCH_MARKER]).toBe(true);
  });

  it('declines to patch a dbus-next that already refcounts correctly', async () => {
    const { applyDbusMatchRefcountPatch, _internals } =
      await import('../../../src/ble/handler-node-ble/dbus-match-patch.js');
    // Simulate a future upstream fix: refcounts correctly, no patch marker.
    // The detection is behavioural, so a fixed implementation is recognised even
    // if its parameter is renamed by a minifier.
    const upstreamFixed = function (
      this: { _matchRules: Record<string, number> },
      match: string,
    ): Promise<unknown> {
      this._matchRules[match] = (this._matchRules[match] ?? 0) + 1;
      return Promise.resolve();
    };
    MessageBus!.prototype._addMatch = upstreamFixed;
    MessageBus!.prototype[PATCH_MARKER] = false;

    _internals.resetForTest();
    applyDbusMatchRefcountPatch();

    expect(MessageBus!.prototype._addMatch).toBe(upstreamFixed);
  });
});
