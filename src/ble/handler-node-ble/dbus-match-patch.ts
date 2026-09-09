import { createRequire } from 'node:module';
import { bleLog, errMsg } from '../types.js';

const nodeRequire = createRequire(import.meta.url);

/** Set before the attempt so a failing patch is not retried on every cycle. */
let patchAttempted = false;

/** Marks a prototype we have already patched, so a second call is a no-op. */
const PATCHED: symbol = Symbol.for('ble-scale-sync.dbus-match-refcount-patched');

interface MatchRuleBus {
  _matchRules: Record<string, number>;
  _connection: { stream: { writable: boolean } };
  call(msg: unknown): Promise<unknown>;
}

/**
 * Repair D-Bus match-rule refcounting in `dbus-next` 0.10.2.
 *
 * Both `_addMatch` and `_removeMatch` in `dbus-next/lib/bus.js` ask
 *
 *     Object.prototype.hasOwnProperty.call(match, this._matchRules)
 *
 * with the arguments the wrong way round: `match` is the rule STRING and
 * `this._matchRules` is the bookkeeping OBJECT, so it tests whether the string
 * has a property named `[object Object]`. That is always false, which means
 * `_addMatch` sends a fresh `AddMatch` for a rule it already holds and
 * `_removeMatch` takes its `else` branch and never sends `RemoveMatch` at all.
 *
 * Nothing above this ever gives a match rule back, so a long-running scan
 * accumulates them on one connection until the bus daemon refuses more:
 *
 *     org.freedesktop.DBus.Error.LimitsExceeded
 *     Connection ":1.1164" is not allowed to add more match rules
 *     (max_match_rules_per_connection=2048)
 *
 * A reporter measured this inside our own image (#396): 50 add/remove pairs on
 * one rule produced 50 `AddMatch` and 0 `RemoveMatch`, and the same module with
 * the argument order corrected produced 50 and 50. On a busy BLE environment the
 * ceiling arrives in about 2.5 hours and takes the process with it.
 *
 * Fixing it upstream is not available: dbusjs/node-dbus-next#110 (2022) and #130
 * are both unmerged and `master` still carries the bug, so there is no version to
 * bump to. Patching the prototype is the same approach already used for
 * `@2colors/esphome-native-api`, and it is preferred over a `patch-package`
 * postinstall because the published Docker image installs with
 * `npm ci --omit=dev` and would not run one.
 *
 * `MessageBus` is not on the package's public export surface, so it is reached
 * through its file path. `createRequire` resolves the same module instance
 * node-ble uses (Node shares the CJS require cache with ESM interop), which is
 * what makes patching the prototype reach the bus node-ble builds.
 *
 * Idempotent, and it declines to patch a version that no longer has the defect,
 * so a future dbus-next bump silently gets its own (fixed) implementation back
 * rather than ours layered on top.
 */
type MatchRuleAdd = (this: MatchRuleBus, match: string) => unknown;

/**
 * Add one rule twice through the shipped implementation and report the refcount
 * it left behind: 2 when refcounting works, 1 when it does not, `undefined` when
 * the probe could not run at all (internals shaped differently than expected).
 *
 * Runs against a throwaway object, never a live bus: `call` resolves without
 * sending anything, so nothing reaches D-Bus.
 */
function probeDoubleAdd(addMatch: MatchRuleAdd): number | undefined {
  try {
    const probe: MatchRuleBus = {
      _matchRules: {},
      _connection: { stream: { writable: true } },
      call: () => Promise.resolve(),
    };
    const rule = "type='signal',interface='dev.blescalesync.PatchProbe'";
    void addMatch.call(probe, rule);
    void addMatch.call(probe, rule);
    const count = probe._matchRules[rule];
    return typeof count === 'number' ? count : undefined;
  } catch {
    return undefined;
  }
}

export function applyDbusMatchRefcountPatch(): void {
  if (patchAttempted) return;
  patchAttempted = true;
  try {
    const MessageBus = nodeRequire('dbus-next/lib/bus.js') as {
      prototype: Record<string | symbol, unknown>;
    };
    const proto = MessageBus?.prototype;
    if (typeof proto?._addMatch !== 'function' || typeof proto?._removeMatch !== 'function') {
      bleLog.debug('D-Bus match-rule patch skipped: dbus-next internals changed.');
      return;
    }
    if (proto[PATCHED] === true) return;

    // Decide by BEHAVIOUR, not by reading the source. A regex over the shipped
    // text is fooled by a minified or transpiled copy whose parameter has been
    // renamed: that copy is still broken, and reporting it as "already correct"
    // would hand somebody chasing LimitsExceeded a false all-clear.
    //
    // The probe is the defect itself: add the same rule twice on a throwaway
    // object whose prototype is theirs. Correct refcounting leaves the count at
    // 2; the reversed hasOwnProperty leaves it at 1, having sent AddMatch twice.
    const refcountAfterTwoAdds = probeDoubleAdd(proto._addMatch as MatchRuleAdd);
    if (refcountAfterTwoAdds === 2) {
      bleLog.debug('D-Bus match-rule patch skipped: this dbus-next already refcounts correctly.');
      return;
    }
    if (refcountAfterTwoAdds === undefined) {
      bleLog.warn(
        'D-Bus match-rule patch skipped: could not determine whether dbus-next refcounts ' +
          'match rules. If this process dies on org.freedesktop.DBus.Error.LimitsExceeded, ' +
          'that is why (#396).',
      );
      return;
    }

    const { Message } = nodeRequire('dbus-next') as {
      Message: new (opts: Record<string, unknown>) => unknown;
    };
    const dbusCall = (member: 'AddMatch' | 'RemoveMatch', match: string): unknown =>
      new Message({
        path: '/org/freedesktop/DBus',
        destination: 'org.freedesktop.DBus',
        interface: 'org.freedesktop.DBus',
        member,
        signature: 's',
        body: [match],
      });

    proto._addMatch = function (this: MatchRuleBus, match: string): Promise<unknown> {
      if (Object.prototype.hasOwnProperty.call(this._matchRules, match)) {
        this._matchRules[match] += 1;
        return Promise.resolve();
      }
      this._matchRules[match] = 1;
      return this.call(dbusCall('AddMatch', match));
    };

    proto._removeMatch = function (this: MatchRuleBus, match: string): Promise<unknown> {
      // Kept from the original: a closed stream cannot carry the RemoveMatch,
      // and the daemon drops every rule with the connection anyway.
      if (!this._connection.stream.writable) return Promise.resolve();
      if (!Object.prototype.hasOwnProperty.call(this._matchRules, match)) {
        return Promise.resolve();
      }
      this._matchRules[match] -= 1;
      if (this._matchRules[match] > 0) return Promise.resolve();
      delete this._matchRules[match];
      return this.call(dbusCall('RemoveMatch', match));
    };

    proto[PATCHED] = true;
    bleLog.debug('D-Bus match-rule refcounting patched (dbus-next 0.10.2, #396)');
  } catch (e: unknown) {
    bleLog.debug(`D-Bus match-rule patch failed, using library default: ${errMsg(e)}`);
  }
}

/** Exposed for the regression test that guards the patched library internals. */
export const _internals = { PATCHED, resetForTest: (): void => void (patchAttempted = false) };
