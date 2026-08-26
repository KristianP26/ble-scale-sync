# #231 ESP32 auto_connect bootstrap fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a GATT-only scale (QN-Scale) reading bootstrap through the ESP32 autonomous-connect path so `auto_connect=true` stops deadlocking in continuous mode (#231).

**Architecture:** Two host-side changes in the mqtt-proxy `ReadingWatcher`. (A) On `start()`, seed the ESP32 known-scale set by publishing the statically configured `scale_mac` to the retained `config` topic, so the ESP32 `_scale_macs` gate is non-empty and autonomous connect can fire. (B) Add a per-MAC deferral counter so that after a few scan cycles of deferring with no autonomous `connected` event, the watcher falls back to a host-initiated GATT connect (safety net for auto-discovery, no `scale_mac`, or a failing autonomous connect). No firmware change.

**Tech Stack:** TypeScript (ES modules, strict), Vitest. Files under `src/ble/handler-mqtt-proxy/`.

---

## Root cause (for context)

The ESP32 only autonomously connects when a known scale MAC is in its `_scale_macs` set (`firmware/main.py:262`). That set is filled only from the retained `config` MQTT topic, which the host publishes only inside `registerScaleMac` (`display.ts:48`), which fires only after a successful reading. A GATT-only scale produces no pre-reading, so the MAC is never seeded, the gate never fires, and the watcher defers forever (`watcher.ts:247`). Deadlock. Single-run `scanAndReadRaw` is unaffected (it always host-connects). Only the continuous `ReadingWatcher` path deadlocks; the reporter runs Docker continuous.

## File Structure

- Modify: `src/ble/handler-mqtt-proxy/watcher.ts` — imports, new field + constant, seed on `start()`, deferral-count fallback in the defer branch, counter resets.
- Modify: `tests/ble/handler-mqtt-proxy.test.ts` — 4 new tests in the existing `ReadingWatcher` / `GATT proxy` describe blocks.
- Modify: `docs/guide/esp32-proxy.md` — short troubleshooting note about auto_connect bootstrap + `scale_mac`.
- Modify: `README.md` — one-line mention under the ESP32 proxy bullet (project rule: README touched every commit).

---

### Task 1: Seed ESP32 config with the configured scale_mac on start (Solution A)

**Files:**
- Modify: `src/ble/handler-mqtt-proxy/watcher.ts` (imports ~8-16; `start()` ~123)
- Test: `tests/ble/handler-mqtt-proxy.test.ts` (in `describe('ReadingWatcher', ...)`)

- [ ] **Step 1: Write the failing tests**

Add inside `describe('ReadingWatcher', () => { ... })`:

```ts
it('seeds ESP32 known-scale set with the configured scale_mac on start (#231)', async () => {
  const adapter = createGattAdapter();
  const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter], 'ff:03:00:53:d6:4d', PROFILE);
  await watcher.start();

  const configCalls = (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls.filter(
    (c: unknown[]) => c[0] === `${PREFIX}/config`,
  );
  expect(configCalls).toHaveLength(1);
  const payload = JSON.parse(configCalls[0][1] as string);
  // MAC is uppercased to match the ESP32 raw-buffer comparison format.
  expect(payload.scales).toContain('FF:03:00:53:D6:4D');
});

it('does not seed config when no scale_mac is configured', async () => {
  const adapter = createGattAdapter();
  const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter]);
  await watcher.start();

  const configCalls = (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls.filter(
    (c: unknown[]) => c[0] === `${PREFIX}/config`,
  );
  expect(configCalls).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ble/handler-mqtt-proxy.test.ts -t "seeds ESP32 known-scale"`
Expected: FAIL (no `config` publish on start).

- [ ] **Step 3: Update imports**

In `src/ble/handler-mqtt-proxy/watcher.ts` change the client.js import to add three accessors and the display.js import to add `publishConfig`:

```ts
import {
  type MqttClient,
  getOrCreatePersistentClient,
  addDiscoveredMac,
  getDiscoveredMacs,
  getDisplayUsers,
} from './client.js';
```

```ts
import { registerScaleMac, publishConfig } from './display.js';
```

- [ ] **Step 4: Seed config in `start()`**

In `start()`, immediately after the line `bleLog.info('ReadingWatcher started, listening for scan results');` (still inside the `try`), add:

```ts
// Seed the ESP32 known-scale set with the statically configured target MAC so
// autonomous GATT connect can bootstrap a GATT-only scale that never emits a
// broadcast reading (#231). Without this, the ESP32 _scale_macs gate stays
// empty and the autonomous-connect path never fires, deadlocking the watcher.
if (this.targetMac) {
  addDiscoveredMac(this.targetMac);
  await publishConfig(this.config, getDiscoveredMacs(), getDisplayUsers()).catch((err) =>
    bleLog.warn(`Failed to seed ESP32 scale config for ${this.targetMac}: ${errMsg(err)}`),
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/ble/handler-mqtt-proxy.test.ts -t "seed"`
Expected: PASS (both new tests).

- [ ] **Step 6: Commit**

```bash
git add src/ble/handler-mqtt-proxy/watcher.ts tests/ble/handler-mqtt-proxy.test.ts
git commit -m "fix(ble): seed ESP32 known-scale set from scale_mac on watcher start (#231)"
```

---

### Task 2: Deferral-count fallback to host-initiated GATT (Solution B)

**Files:**
- Modify: `src/ble/handler-mqtt-proxy/watcher.ts` (field ~71; defer branch ~247-257; autonomous handler ~142; `handleGattReading` ~377)
- Test: `tests/ble/handler-mqtt-proxy.test.ts` (in `describe('GATT proxy', ...)`)

- [ ] **Step 1: Write the failing tests**

Add inside `describe('GATT proxy', () => { ... })`:

```ts
it('falls back to host-initiated GATT after repeated deferrals with no autonomous connect (#231)', async () => {
  // auto_connect default true, NO scale_mac → no seeding: reproduces the
  // auto-discovery deadlock where the ESP32 never autonomously connects.
  const adapter = createGattAdapter();
  const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter], undefined, PROFILE);
  await watcher.start();

  const origPublish = mockClient.publishAsync;
  let connectReceived = false;
  mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
    if (topic === `${PREFIX}/connect`) {
      connectReceived = true;
      queueMicrotask(() =>
        mockClient._simulateMessage(
          `${PREFIX}/connected`,
          JSON.stringify({
            chars: [
              { uuid: GATT_NOTIFY_UUID, properties: ['notify'] },
              { uuid: GATT_WRITE_UUID, properties: ['write'] },
            ],
          }),
        ),
      );
    }
    if (topic === `${PREFIX}/write/${GATT_WRITE_UUID}`) {
      queueMicrotask(() => {
        const buf = Buffer.alloc(4);
        buf.writeUInt16LE(7700, 0); // 77.00 kg
        buf.writeUInt16LE(510, 2); // impedance 510
        mockClient._simulateMessage(`${PREFIX}/notify/${GATT_NOTIFY_UUID}`, buf);
      });
    }
    return origPublish(topic, payload);
  });

  const scanMsg = JSON.stringify([
    { address: 'AA:BB:CC:DD:EE:FF', name: 'GattScale', rssi: -50, services: [] },
  ]);

  // Deferral 1 and 2 stay below the fallback threshold.
  mockClient._simulateMessage(`${PREFIX}/scan/results`, scanMsg);
  expect(connectReceived).toBe(false);
  mockClient._simulateMessage(`${PREFIX}/scan/results`, scanMsg);
  expect(connectReceived).toBe(false);
  // Deferral 3 reaches the threshold → host-initiated GATT fires.
  mockClient._simulateMessage(`${PREFIX}/scan/results`, scanMsg);

  const raw = await watcher.nextReading();
  expect(raw.reading.weight).toBe(77.0);
  expect(connectReceived).toBe(true);
});

it('autonomous connect resets the deferral counter (no premature host fallback) (#231)', async () => {
  const adapter = createGattAdapter();
  const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter], undefined, PROFILE);
  await watcher.start();

  const origPublish = mockClient.publishAsync;
  let hostConnects = 0;
  mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
    if (topic === `${PREFIX}/connect`) hostConnects++;
    if (topic === `${PREFIX}/write/${GATT_WRITE_UUID}`) {
      queueMicrotask(() => {
        const buf = Buffer.alloc(4);
        buf.writeUInt16LE(8800, 0); // 88.00 kg
        buf.writeUInt16LE(530, 2); // impedance 530
        mockClient._simulateMessage(`${PREFIX}/notify/${GATT_NOTIFY_UUID}`, buf);
      });
    }
    return origPublish(topic, payload);
  });

  const scanMsg = JSON.stringify([
    { address: 'AA:BB:CC:DD:EE:FF', name: 'GattScale', rssi: -50, services: [] },
  ]);

  // Two deferrals (below threshold).
  mockClient._simulateMessage(`${PREFIX}/scan/results`, scanMsg);
  mockClient._simulateMessage(`${PREFIX}/scan/results`, scanMsg);

  // Autonomous connect arrives → reading AND counter reset.
  mockClient._simulateMessage(
    `${PREFIX}/connected`,
    JSON.stringify({
      autonomous: true,
      address: 'AA:BB:CC:DD:EE:FF',
      chars: [
        { uuid: GATT_NOTIFY_UUID, properties: ['notify'] },
        { uuid: GATT_WRITE_UUID, properties: ['write'] },
      ],
    }),
  );
  const raw = await watcher.nextReading();
  expect(raw.reading.weight).toBe(88.0);

  // Two more deferrals — counter was reset, so still below threshold.
  mockClient._simulateMessage(`${PREFIX}/scan/results`, scanMsg);
  mockClient._simulateMessage(`${PREFIX}/scan/results`, scanMsg);
  await new Promise((r) => setTimeout(r, 50));

  // Never fell back to a host-initiated GATT connect.
  expect(hostConnects).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ble/handler-mqtt-proxy.test.ts -t "deferral"`
Expected: FAIL (first test: host connect never fires, `nextReading` hangs/times out; the defer branch currently always `continue`s).

- [ ] **Step 3: Add the field and threshold constant**

In `src/ble/handler-mqtt-proxy/watcher.ts`, add a field next to the other private maps (after `_subscribedTopics`):

```ts
  /** Per-MAC count of consecutive scan deferrals with no autonomous connect (#231). */
  private deferCounts = new Map<string, number>();
```

Add the threshold constant next to `GATT_STALE_MS`:

```ts
  /**
   * Number of consecutive auto_connect deferrals for one MAC before the watcher
   * falls back to a host-initiated GATT connect (#231). Generous enough that a
   * seeded ESP32 (Solution A) autonomously connects first; only a never-firing
   * autonomous path (auto-discovery / no scale_mac) reaches the fallback.
   */
  private static readonly AUTO_CONNECT_FALLBACK_DEFERS = 3;
```

- [ ] **Step 4: Replace the defer branch**

In the scan-results loop, replace this block:

```ts
          if (this.config.auto_connect !== false) {
            bleLog.debug(
              `Skipping host-initiated GATT for ${entry.address} — auto_connect enabled, ` +
                `waiting for autonomous connect from ESP32`,
            );
            continue;
          }

          this.handleGattReading(entry, adapter).catch((err) => {
            bleLog.warn(`GATT reading failed for ${entry.address}: ${errMsg(err)}`);
          });
```

with:

```ts
          if (this.config.auto_connect !== false) {
            // The ESP32 connects autonomously when it sees a known scale MAC.
            // But if it never fires (its known-scale set was never seeded, or
            // the autonomous connect keeps failing), deferring forever
            // deadlocks a GATT-only scale (#231). After a few deferrals with no
            // autonomous `connected` event, fall back to host-initiated GATT.
            const deferred = (this.deferCounts.get(entry.address) ?? 0) + 1;
            this.deferCounts.set(entry.address, deferred);
            if (deferred < ReadingWatcher.AUTO_CONNECT_FALLBACK_DEFERS) {
              bleLog.debug(
                `Skipping host-initiated GATT for ${entry.address}: auto_connect enabled, ` +
                  `waiting for autonomous connect (defer ${deferred}/${ReadingWatcher.AUTO_CONNECT_FALLBACK_DEFERS})`,
              );
              continue;
            }
            bleLog.warn(
              `No autonomous connect from ESP32 for ${entry.address} after ${deferred} scans; ` +
                `falling back to host-initiated GATT (#231)`,
            );
            // fall through to the host-initiated GATT path below
          }

          this.handleGattReading(entry, adapter).catch((err) => {
            bleLog.warn(`GATT reading failed for ${entry.address}: ${errMsg(err)}`);
          });
```

- [ ] **Step 5: Reset the counter on autonomous connect**

In the message handler, inside the `if (data.autonomous && data.address)` block (before the `bleLog.info(...)` call), add:

```ts
            // The ESP32 fired its autonomous connect — stop counting deferrals
            // so the host fallback never races a working autonomous path (#231).
            this.deferCounts.delete(data.address);
```

- [ ] **Step 6: Reset the counter on a successful host fallback read**

In `handleGattReading`, immediately after `this.queue.push(raw);`, add:

```ts
      this.deferCounts.delete(entry.address);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/ble/handler-mqtt-proxy.test.ts -t "deferral"`
Expected: PASS (both new tests).

- [ ] **Step 8: Run the full mqtt-proxy suite (regression guard)**

Run: `npx vitest run tests/ble/handler-mqtt-proxy.test.ts`
Expected: PASS, all tests (the existing `combined scan/results then autonomous connected succeeds without race` proves one defer then autonomous still takes the autonomous path).

- [ ] **Step 9: Commit**

```bash
git add src/ble/handler-mqtt-proxy/watcher.ts tests/ble/handler-mqtt-proxy.test.ts
git commit -m "fix(ble): fall back to host GATT after auto_connect deferrals stall (#231)"
```

---

### Task 3: Docs + README

**Files:**
- Modify: `docs/guide/esp32-proxy.md`
- Modify: `README.md`

- [ ] **Step 1: Add a troubleshooting note to the ESP32 proxy guide**

Find the auto_connect / troubleshooting section in `docs/guide/esp32-proxy.md` and add (adapt heading to match the file):

```markdown
### A GATT-only scale never connects with auto_connect

Some scales (for example the QN-Scale) expose no broadcast data and must be
GATT-connected to read. With `auto_connect` enabled, the ESP32 connects itself
the moment it sees a known scale MAC. Set `ble.scale_mac` to your scale so the
host seeds that MAC to the ESP32 at startup. Without a `scale_mac`, the host
falls back to a slower host-initiated connect after a few scan cycles.
```

- [ ] **Step 2: Add a one-line README mention**

In `README.md`, near the ESP32 proxy bullet, add a short note that `scale_mac` is recommended for GATT-only scales over the ESP32 proxy. Keep it to one line. (No em dash, no double dash.)

- [ ] **Step 3: Commit**

```bash
git add docs/guide/esp32-proxy.md README.md
git commit -m "docs: note scale_mac recommendation for GATT-only scales over ESP32 proxy (#231)"
```

---

### Task 4: Full verification

- [ ] **Step 1: Kill node, run full checks**

```bash
taskkill //F //IM node.exe
npm test
npm run lint
npx prettier --check .
npx tsc --noEmit
```
Expected: all green.

- [ ] **Step 2: Firmware tests still pass (no firmware change, sanity only)**

Run: `python -m unittest discover -s firmware/tests`
Expected: PASS.

---

## Self-Review

**Spec coverage:** Solution A = Task 1 (seed on start). Solution B = Task 2 (defer-count fallback + resets). Docs/README rule = Task 3. Verification = Task 4. All covered.

**Placeholder scan:** No TBD/TODO. All code blocks concrete.

**Type consistency:** `deferCounts: Map<string, number>` used consistently; keyed by `entry.address` (defer + fallback reset) and `data.address` (autonomous reset), both ESP32 uppercase-colon MACs. `AUTO_CONNECT_FALLBACK_DEFERS` referenced via `ReadingWatcher.AUTO_CONNECT_FALLBACK_DEFERS`. Imports `addDiscoveredMac`, `getDiscoveredMacs`, `getDisplayUsers` (client.js), `publishConfig` (display.js), `errMsg` (already imported from types.js).
