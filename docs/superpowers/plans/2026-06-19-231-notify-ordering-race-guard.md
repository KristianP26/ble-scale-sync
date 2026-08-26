# ESP32 Proxy Lazy Host-Ordered Notify Enable (#231) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the #231 proxy notify-ordering race that loses the QN / Renpho ES-CS20M spontaneous 0x12 handshake-kickoff frame. Make the ESP32 MQTT proxy enable BLE notify LAZILY and HOST-ORDERED (the host subscribes to the MQTT notify topic FIRST, then commands the firmware to enable BLE notify), matching native `char.subscribe()` semantics so the firmware-triggered kickoff frame always has a listener.

**Architecture:** Today the firmware enables BLE notify eagerly the instant it discovers chars (`firmware/main.py` `_auto_gatt_connect` and `handle_connect`), before the host has subscribed to the `notify/<uuid>` MQTT topic; the QN scale emits its 0x12 the moment its CCCD is written and that QoS 0 frame is dropped into an unsubscribed topic. The fix splits the proxy notify-enable to mirror native: the host's `MqttBleChar.subscribe()` (the single chokepoint every proxy notify subscription funnels through via `shared.ts` `subscribeToChar` -> `char.subscribe`) first subscribes to `notify/<uuid>` and registers its message handler, THEN publishes a per-char enable command on a new `subscribe/<uuid>` topic. The firmware stops eager-enabling, subscribes to a `subscribe/#` wildcard, and on a `subscribe/<uuid>` command calls `bridge.start_notify(uuid, forward_fn)` (the forward_fn publishes `notify/<uuid>` exactly as today). Backward compatibility is handled by capability negotiation through the existing retained `config` topic: the host adds `lazy_notify: true` to the config payload it already publishes at startup; the firmware enables notify lazily only when it has seen that flag, otherwise it falls back to today's eager enable. New host is race-free; an old host never sends the flag so new firmware stays eager (no regression); old firmware ignores the new flag and the new command and behaves exactly as today. The time-critical CONNECT stays autonomous on the ESP32; only the per-char notify-enable becomes one host round-trip after connect, inside the connection window.

**Tech Stack:** TypeScript host (strict, ES2022, Node16, ESM with `.js` import extensions), Vitest, ESLint, Prettier; MicroPython firmware (aioble, mqtt_as) with host-runnable CPython `unittest` tests (`sys.modules` stubs). CI gates both: `npm run lint` + `npm run format:check` + `npx tsc --noEmit` + `npm test` for the host, and `python -m unittest discover -s firmware/tests -v` + `python -m py_compile` for the firmware (`.github/workflows/ci.yml`).

## Global Constraints

- TWO codebases. TS host under `src/`; MicroPython firmware under `firmware/`. A task that changes only one side runs that side's gate; a task that changes both runs BOTH gates.
- TS gate (bash): `taskkill //F //IM node.exe` then `npx tsc --noEmit`, `npm run lint`, `npm test`, and `npx prettier --check` on the changed files.
- FIRMWARE gate (bash): `python -m unittest discover -s firmware/tests -v` and `python -m py_compile` on each edited firmware file.
- Kill node before any npm/npx command (bash): `taskkill //F //IM node.exe`.
- ES Modules in TS: all relative imports use the `.js` extension even from `.ts`. TypeScript strict; `npx tsc --noEmit` clean.
- Prettier: semicolons, single quotes, trailing commas, 100 char width. ESLint clean (`_` prefix for unused).
- Firmware stays valid MicroPython AND host-importable: every MicroPython-only module (`aioble`, `bluetooth`, `board`, `mqtt_as`, `ble_bridge`) is stubbed in `sys.modules` by the tests; `asyncio.sleep_ms` is shimmed.
- Never use an em dash or a double dash anywhere (code, comments, commit messages, docs, this plan). Rewrite the sentence instead.
- Conventional Commits, per task: `fix(ble):` for host proxy code, `fix(firmware):` for firmware code, `test(ble):` / `test(firmware):` for test-only commits. Do NOT edit `package.json` / `CHANGELOG.md` versions by hand. NO AI attribution.
- NEVER `git add -A` in this repo (it stages untracked `docs/superpowers/plans/*.md`). Use explicit `git add <named files>`.
- Work on `dev` (already checked out). Do not touch `main`. Do NOT push (the orchestrator pushes after review). Do NOT close #231.
- Behavior preservation is the dominant requirement: every existing TS test (baseline ~1817) and every firmware test (baseline 76) MUST stay green at EVERY commit. The S3/PSRAM and non-QN proxy paths must not regress.
- Commit ordering is a hard constraint: firmware and host must agree on the wire protocol, so sequence commits so no commit leaves the proxy broken for the EXISTING test suites. The chosen order (firmware first) is safe because each firmware commit keeps the firmware eager by default (lazy only when the flag is present, which no committed host sends yet), and the host commit that starts sending the flag and the command lands only after the firmware understands both.

---

## Background facts (verified against the codebase, 2026-06-19)

### Host (TypeScript)

- `src/ble/handler-mqtt-proxy/gatt.ts` `MqttBleChar.subscribe(onData)` (lines 14-24) is the single host-side chokepoint for every proxy notify subscription. It computes `topic = \`${this.base}/notify/${this.uuid}\``, registers `this.client.on('message', handler)`, then `await this.client.subscribeAsync(topic)`, and returns an unsubscribe closure. `this.base` and `this.uuid` are constructor fields (lines 8-12); `this.uuid` is the ORIGINAL (un-normalized, possibly mixed-case) UUID the ESP32 reported, which is exactly the case used in the `notify/`, `write/`, and `read/` topics. This is where the new enable-notify publish goes, AFTER the `subscribeAsync`.
- `src/ble/shared.ts` `subscribeToChar` (lines 130-139) -> `char.subscribe(...)` is reached from BOTH notify paths: multi-char bindings and legacy single notify in `subscribeAndInit` (lines 233-314), and `ConnectionContext.subscribe` in `initializeAdapter` (lines 182-185). All proxy notify subscriptions therefore funnel through `MqttBleChar.subscribe`. Confirmed: nothing else constructs or subscribes an `MqttBleChar`.
- `src/ble/handler-mqtt-proxy/topics.ts` (lines 6-21) builds the topic record from `base = \`${prefix}/${deviceId}\``. `Topics` is `ReturnType<typeof topics>` (line 23). The watcher and gatt code call `topics(this.config.topic_prefix, this.config.device_id)` per use. This file is NOT modified by this plan: the per-char `subscribe/<uuid>` command is built directly from `this.base`/`this.uuid` inside `MqttBleChar.subscribe` (just like `notify`/`write`/`read`), so a `topics()` field would be dead.
- `src/ble/handler-mqtt-proxy/display.ts` `publishConfig` (lines 15-37) builds `const payload: Record<string, unknown> = { scales }`, conditionally adds `payload.users` and `payload.autoConnect = false`, then `client.publishAsync(t.config, JSON.stringify(payload), { retain: true })`. This is the startup config publish. It is called from `ReadingWatcher.start()` (watcher.ts:151) when a `targetMac` is seeded, and from `registerScaleMac` (display.ts:48). The `lazy_notify` flag is added here.
- `src/ble/handler-mqtt-proxy/watcher.ts` `ReadingWatcher`: `handleAutonomousConnect` (lines 410-502) builds the char map via `buildCharMapFromPayload` and runs `waitForRawReading`; `handleGattReading` (lines 344-401) does the host-initiated connect then `waitForRawReading`. Both reach `MqttBleChar.subscribe` through `waitForRawReading`.
- `MqttProxyConfig` (`src/config/schema.ts:199`, `MqttProxySchema` lines 40-80) has `auto_connect` (boolean, default true) but no notify field. `lazy_notify` is a WIRE-PROTOCOL detail published in the config payload, NOT a user-facing Zod option, so NO schema change is needed; the host always advertises `lazy_notify: true`.
- Host test harness: `tests/ble/handler-mqtt-proxy.test.ts` (2094 lines) mocks `mqtt` via `vi.mock('mqtt', ...)` returning a `MockMqttClient` whose `_simulateMessage(topic, payload)` drives the `'message'` listeners. Existing GATT flows trigger a notify by simulating a frame on `notify/<uuid>` in response to the host's `write/<uuid>` publish (e.g. the autonomous test at lines 1708-1751 and the host-initiated test at lines 1414-1466). None of them currently depend on a `subscribe/<uuid>` publish, so they tolerate the new publish unchanged. `publishConfig` tests (lines 721-760) assert the EXACT serialized config payload, so they MUST be updated when `lazy_notify` is added.
- `PREFIX = 'ble-proxy/esp32-test'` in the host test; topics are `\`${PREFIX}/notify/${uuid}\`` etc.

### Firmware (MicroPython)

- `firmware/main.py` `on_message` (lines 77-93) is the sync MQTT callback. For `topic("config")` it parses `_scale_macs = set(data.get("scales", []))` and `_auto_connect = data.get("autoConnect", True)` (lines 84-85) and returns; everything else is appended to `_pending` (line 93). The `lazy_notify` flag is parsed here next to `_auto_connect`.
- `on_connect` (lines 96-116) subscribes the command topics after every (re)connect: `connect`, `disconnect`, `config`, `beep`, optional display topics, and (only when `_char_subscribed`) `write/#` and `read/#` (lines 109-111). The new `subscribe/#` wildcard subscription goes here.
- `_auto_gatt_connect` (lines 197-255): after a successful `bridge.connect`, lines 219-222 subscribe `write/#` + `read/#` once (`_char_subscribed` guard), then the EAGER notify loop at lines 224-234 iterates `result["chars"]`, and for each char with `"notify"` in its properties builds a `make_publish_fn(uuid_str)` and calls `await bridge.start_notify(uuid_str, make_publish_fn(uuid_str))` then prints `Auto-connect: notify enabled for {uuid_str}`. This eager loop is what must become conditional on the lazy flag.
- `handle_connect` (lines 415-467): the host-initiated equivalent. Lines 443-446 subscribe `write/#` + `read/#`; lines 448-457 are the identical eager notify loop (no print line). Also conditional on the lazy flag.
- The `make_publish_fn` closure (auto: lines 228-231; host: lines 452-455) is `async def publish_fn(_source_uuid, data): await client.publish(topic(f"notify/{u}"), data, qos=0)`. The lazy command handler reuses this exact forward function.
- Main loop dispatch (lines 541-615): pops `_pending`, matches `__ble_disconnected__`, `topic("connect")`, `topic("disconnect")`, `topic("beep")`, display topics, then `t.startswith(topic("write/"))` (lines 604-606) and `t.startswith(topic("read/"))` (lines 607-610). The new `subscribe/<uuid>` dispatch branch goes here next to write/read.
- `firmware/ble_bridge.py` `start_notify(self, uuid_str, publish_fn)` (lines 574-597) already exists: it looks up `self._chars.get(uuid_str)`, returns early if absent, and spawns a `_notify_loop` task that awaits `char.notified()` and calls `publish_fn(uuid_str, bytes(data))`. `self._chars` is populated during `connect()` discovery (lines 545-546). No new bridge helper is needed; `start_notify` is called on demand by the firmware command handler.
- Firmware test harness: `firmware/tests/test_auto_connect.py` imports `main` under stubbed `aioble`/`bluetooth`/`board`/`mqtt_as`/`ble_bridge` (lines 20-93), writes a minimal `config.json`, and shims `asyncio.sleep_ms`. The `ble_bridge` stub there (lines 56-64) is a `SimpleNamespace` with no `connect`/`start_notify`. `firmware/tests/test_connect_irq.py` installs a richer `aioble`/`bluetooth` stub and imports the REAL `ble_bridge` (it pops the cached stub at line 209). `firmware/tests/test_board_config.py` imports pure board-constant modules. Baseline: 76 tests, `OK`.
- CI (`.github/workflows/ci.yml`): host job runs `npm run lint`, `npm run format:check`, `npx tsc --noEmit`, `npm test` on Node 22/24/26; `python-check` job runs `python -m py_compile` on the garmin scripts and `python -m unittest discover -s firmware/tests -v`.

### Why Option 1 (capability negotiation), not Option 2 (grace fallback)

The dangerous mixed-version case is NEW firmware (lazy-only) + OLD host (never sends the command) -> notify never enabled -> ALL proxy scales break. Option 1 (config flag `lazy_notify`) eliminates this with no timing window: the firmware only goes lazy when it has positively seen the flag from a new host, so new-firmware + old-host stays eager (identical to today, still racy for QN but no regression). The host already publishes a RETAINED `config` at startup, so the flag is redelivered after any firmware reboot and is guaranteed to arrive before the autonomous connect fires (the ESP32 subscribes `config` in `on_connect` before the scan loop publishes results). Option 2 (a ~750 ms grace before eager-enabling) would delay enable for every old host and risk marginally regressing a currently-working non-QN scale whose connection window is short; it also adds a timing knob to justify per board. Option 1 is deterministic and is chosen. OLD firmware + NEW host is inherently safe either way: old firmware eager-enables and ignores both the new flag and the new command.

---

## Task 1: Firmware reads the `lazy_notify` config flag (default off, still eager)

Add the capability flag parse and a module global, defaulting to eager. This commit changes ONLY firmware and keeps eager behavior for everyone (no host sends the flag yet), so both suites stay green and the proxy is unchanged.

**Files:**
- Modify: `firmware/main.py` (`on_message` config branch; add `_lazy_notify` global)
- Modify: `firmware/tests/test_auto_connect.py` (extend `TestAutoConnectConfig` with lazy-flag parse tests)

**Interfaces:**
- Consumes: the `config` topic payload `data` dict in `on_message`.
- Produces: module global `main._lazy_notify` (bool, default `False`), set from `data.get("lazy_notify", False)`.

- [ ] **Step 1: Write the failing test**

In `firmware/tests/test_auto_connect.py`, add a new test class after `TestAutoConnectConfig` (the existing class ends at the `test_explicit_false` method around line 221):

```python
class TestLazyNotifyConfig(unittest.TestCase):
    """_lazy_notify capability flag parsing from the config topic (#231).

    The host advertises lazy_notify so the firmware enables BLE notify only on a
    per-char subscribe command (host-ordered). Absent flag = eager (old host)."""

    def tearDown(self):
        main._lazy_notify = False

    def test_default_is_false(self):
        main._lazy_notify = False
        self.assertFalse(main._lazy_notify)

    def test_missing_field_defaults_false(self):
        data = {"scales": ["AA:BB:CC:DD:EE:FF"]}
        main._lazy_notify = data.get("lazy_notify", False)
        self.assertFalse(main._lazy_notify)

    def test_explicit_true(self):
        data = {"scales": [], "lazy_notify": True}
        main._lazy_notify = data.get("lazy_notify", False)
        self.assertTrue(main._lazy_notify)

    def test_explicit_false(self):
        data = {"scales": [], "lazy_notify": False}
        main._lazy_notify = data.get("lazy_notify", False)
        self.assertFalse(main._lazy_notify)

    def test_global_exists_with_default(self):
        # The module must define _lazy_notify at import time so on_message can
        # assign it and the connect handlers can read it.
        self.assertTrue(hasattr(main, "_lazy_notify"))
```

- [ ] **Step 2: Run the test to verify it fails**

Run (bash):
```bash
taskkill //F //IM node.exe 2>/dev/null || true
python -m unittest firmware.tests.test_auto_connect.TestLazyNotifyConfig -v
```
Expected: FAIL on `test_global_exists_with_default` (`AttributeError: module 'main' has no attribute '_lazy_notify'`). The other four assign `main._lazy_notify` directly so they pass trivially; the presence test is the real red.

- [ ] **Step 3: Add the `_lazy_notify` global and parse it in `on_message`**

In `firmware/main.py`, add the global next to `_auto_connect` (after line 53):

```python
# Lazy host-ordered notify enable (#231): when the host advertises
# lazy_notify=True on the config topic, BLE notify is enabled only on a per-char
# subscribe/<uuid> command (after the host has subscribed to notify/<uuid>), so
# the QN/Renpho ES-CS20M spontaneous 0x12 kickoff frame is never lost. Absent
# flag (old host) keeps today's eager enable, so there is no regression.
_lazy_notify = False
```

Then update the `global` declaration and the parse in `on_message` (lines 79-86). Change:

```python
    global _scale_macs, _auto_connect
```
to:
```python
    global _scale_macs, _auto_connect, _lazy_notify
```

and after the `_auto_connect = data.get("autoConnect", True)` line add:

```python
            _lazy_notify = data.get("lazy_notify", False)
```

Optionally extend the existing config print to include the flag (keep it one line, no double dash):

```python
            print(f"Config: {len(_scale_macs)} scale MAC(s), autoConnect={_auto_connect}, lazyNotify={_lazy_notify}")
```

- [ ] **Step 4: Run the new test class + the full firmware suite**

Run (bash):
```bash
python -m unittest firmware.tests.test_auto_connect.TestLazyNotifyConfig -v
python -m unittest discover -s firmware/tests -v 2>&1 | grep -E "^Ran|^OK|^FAILED"
```
Expected: the lazy class PASSES (5 tests); the full suite reports `Ran 81 tests` and `OK` (76 baseline + 5 new).

- [ ] **Step 5: Firmware gate + commit**

```bash
python -m py_compile firmware/main.py
git add firmware/main.py firmware/tests/test_auto_connect.py
git commit -m "fix(firmware): parse lazy_notify capability flag from config (#231)"
```
Expected: `py_compile` clean; commit succeeds. Proxy behavior is unchanged (flag defaults off; nothing reads it yet).

---

## Task 2: Firmware enables notify lazily on a `subscribe/<uuid>` command; eager loops become conditional

Stop eager-enabling when `_lazy_notify` is set; subscribe a `subscribe/#` wildcard; dispatch `subscribe/<uuid>` in the main loop to `bridge.start_notify`. Firmware-only commit. Because no committed host sends `lazy_notify` yet, the firmware still runs the eager path in every existing test, so the suite stays green; the new lazy path is proven by new tests that set `main._lazy_notify = True` and drive a fake bridge.

**Files:**
- Modify: `firmware/main.py` (make both eager loops conditional; subscribe `subscribe/#` in `on_connect`; add a `subscribe/<uuid>` dispatch branch and a `handle_subscribe` helper)
- Modify: `firmware/tests/test_auto_connect.py` (add lazy/eager behavior tests with a fake bridge that records `start_notify` calls)

**Interfaces:**
- Consumes: `main._lazy_notify`, `result["chars"]` (list of `{"uuid", "properties"}`), `bridge.start_notify(uuid, publish_fn)`, the `make_publish_fn` forward-function shape, the `_pending` queue, `topic("subscribe/...")`.
- Produces: `handle_subscribe(uuid_str)` coroutine (calls `bridge.start_notify(uuid_str, make_publish_fn(uuid_str))`); a shared module-level `make_publish_fn` (hoisted so both the eager loops and `handle_subscribe` use ONE definition); `on_connect` subscribes `topic("subscribe/#")`; main loop dispatches `t.startswith(topic("subscribe/"))`.

- [ ] **Step 1: Write the failing tests**

In `firmware/tests/test_auto_connect.py`, add a recording fake-bridge helper and a test class. Place after `TestLazyNotifyConfig`:

```python
class _RecordingBridge:
    """Minimal bridge double that records start_notify(uuid, fn) calls so a test
    can assert whether the connect handlers enabled notify eagerly or not (#231).
    Models just the surface main.handle_connect / _auto_gatt_connect touch."""

    def __init__(self):
        self.started = []  # list of uuid_str passed to start_notify

    def stop_streaming(self):
        pass

    def start_streaming(self):
        pass

    async def disconnect(self):
        pass

    async def connect(self, address, addr_type=0):
        return {
            "chars": [
                {"uuid": "0000fff100001000800000805f9b34fb", "properties": ["notify"]},
                {"uuid": "0000fff200001000800000805f9b34fb", "properties": ["write"]},
            ]
        }

    async def start_notify(self, uuid_str, publish_fn):
        self.started.append(uuid_str)

    def set_on_disconnect(self, cb):
        pass


class _NoopClient:
    """Async client double: subscribe/publish record their topics (and otherwise
    no-op) so the connect handlers can run on a host without a broker AND a test
    can assert which topics were subscribed/published (#231)."""

    def __init__(self):
        self.subscribed = []  # list of subscribed topics
        self.published = []  # list of published topics

    async def subscribe(self, topic, qos=0):
        self.subscribed.append(topic)

    async def publish(self, topic, payload, qos=0, retain=False):
        self.published.append(topic)

    def isconnected(self):
        return True


class TestLazyNotifyEnable(unittest.IsolatedAsyncioTestCase):
    """handle_connect / _auto_gatt_connect must NOT eager-enable notify when
    _lazy_notify is set, and handle_subscribe must enable a single char on
    demand. The eager (old-host) path must still enable on connect (#231)."""

    def setUp(self):
        self._orig_bridge = main.bridge
        self._orig_client = main.client
        self._orig_lazy = main._lazy_notify
        self._orig_char_sub = main._char_subscribed
        self._orig_continuous = main.board.CONTINUOUS_SCAN
        main.bridge = _RecordingBridge()
        main.client = _NoopClient()
        main._char_subscribed = True  # skip the write/read wildcard subscribe path
        main.board.CONTINUOUS_SCAN = False

    def tearDown(self):
        main.bridge = self._orig_bridge
        main.client = self._orig_client
        main._lazy_notify = self._orig_lazy
        main._char_subscribed = self._orig_char_sub
        main.board.CONTINUOUS_SCAN = self._orig_continuous
        main._busy = False
        main._scan_paused = False

    async def test_handle_connect_eager_when_flag_absent(self):
        main._lazy_notify = False
        import json as _json
        await main.handle_connect(_json.dumps({"address": "84:FC:E6:53:06:1C", "addr_type": 0}))
        # Old-host behavior: notify enabled eagerly for the one notify char.
        self.assertEqual(main.bridge.started, ["0000fff100001000800000805f9b34fb"])

    async def test_handle_connect_does_not_eager_enable_when_lazy(self):
        main._lazy_notify = True
        import json as _json
        await main.handle_connect(_json.dumps({"address": "84:FC:E6:53:06:1C", "addr_type": 0}))
        # Lazy: connect publishes chars but enables NO notify until a subscribe cmd.
        self.assertEqual(main.bridge.started, [])

    async def test_auto_connect_does_not_eager_enable_when_lazy(self):
        main._lazy_notify = True
        await main._auto_gatt_connect("84:FC:E6:53:06:1C", 0)
        self.assertEqual(main.bridge.started, [])

    async def test_handle_subscribe_enables_named_char(self):
        main._lazy_notify = True
        # Connect first so bridge has chars (the recording bridge ignores them,
        # but this mirrors the real ordering).
        await main._auto_gatt_connect("84:FC:E6:53:06:1C", 0)
        self.assertEqual(main.bridge.started, [])
        await main.handle_subscribe("0000fff100001000800000805f9b34fb")
        self.assertEqual(main.bridge.started, ["0000fff100001000800000805f9b34fb"])

    async def test_lazy_connect_still_publishes_connected(self):
        # The fix only DEFERS notify; the connect publish (chars -> host) must be
        # unchanged in lazy mode. Pin it so a regression that drops the connected
        # publish when lazy is caught by the firmware suite (#231).
        main._lazy_notify = True
        await main._auto_gatt_connect("84:FC:E6:53:06:1C", 0)
        self.assertEqual(main.bridge.started, [])  # notify deferred
        self.assertIn(main.topic("connected"), main.client.published)

    async def test_on_connect_subscribes_subscribe_wildcard(self):
        # on_connect must subscribe the per-char notify-enable wildcard so the
        # firmware is ready for subscribe/<uuid> after a connect (#231). With a
        # char already subscribed, write/# and read/# are also (re)subscribed.
        await main.on_connect(main.client)
        self.assertIn(main.topic("subscribe/#"), main.client.subscribed)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (bash):
```bash
taskkill //F //IM node.exe 2>/dev/null || true
python -m unittest firmware.tests.test_auto_connect.TestLazyNotifyEnable -v
```
Expected: FAIL. `test_handle_subscribe_enables_named_char` errors (`AttributeError: module 'main' has no attribute 'handle_subscribe'`). `test_handle_connect_does_not_eager_enable_when_lazy`, `test_auto_connect_does_not_eager_enable_when_lazy`, and `test_lazy_connect_still_publishes_connected` FAIL because the current code eager-enables unconditionally (`bridge.started == ['0000fff1...']`, expected `[]`). `test_on_connect_subscribes_subscribe_wildcard` FAILS because the current `on_connect` does not subscribe `subscribe/#`. `test_handle_connect_eager_when_flag_absent` passes against current code (the connected-publish assertion in `test_lazy_connect_still_publishes_connected` would pass on its own, but its first assertion `bridge.started == []` is the red).

- [ ] **Step 3: Hoist `make_publish_fn`, add `handle_subscribe`, gate the eager loops, subscribe `subscribe/#`, dispatch the command**

In `firmware/main.py`:

(a) Hoist ONE module-level forward-function factory so the eager loops and the lazy command handler share it. Add near the other command handlers (for example just before `handle_connect`, after the `_auto_gatt_connect` block):

```python
def make_publish_fn(u):
    """Forward notifications from char `u` to notify/<u> (qos 0), as today."""
    async def publish_fn(_source_uuid, data):
        await client.publish(topic(f"notify/{u}"), data, qos=0)
    return publish_fn


async def handle_subscribe(uuid_str):
    """Enable BLE notify on one characteristic on host command (#231 lazy mode).

    The host publishes subscribe/<uuid> AFTER it has subscribed to the MQTT
    notify/<uuid> topic, so the firmware-triggered kickoff frame (QN 0x12) always
    has a listener. Mirrors native char.subscribe() ordering over the proxy."""
    await bridge.start_notify(uuid_str, make_publish_fn(uuid_str))
    print(f"Subscribe: notify enabled for {uuid_str}")
```

(b) Replace the EAGER loop in `_auto_gatt_connect` (lines 224-234) so it only runs when NOT lazy, and uses the hoisted factory:

```python
        if not _lazy_notify:
            for char_info in result["chars"]:
                if "notify" in char_info["properties"]:
                    uuid_str = char_info["uuid"]
                    await bridge.start_notify(uuid_str, make_publish_fn(uuid_str))
                    print(f"Auto-connect: notify enabled for {uuid_str}")
```

(c) Replace the EAGER loop in `handle_connect` (lines 448-457) the same way (no print, matching today):

```python
        if not _lazy_notify:
            for char_info in result["chars"]:
                if "notify" in char_info["properties"]:
                    uuid_str = char_info["uuid"]
                    await bridge.start_notify(uuid_str, make_publish_fn(uuid_str))
```

Delete the now-removed inline `def make_publish_fn(u): ...` definitions that previously lived inside each loop (lines 228-231 and 452-455); they are replaced by the single hoisted one. Ensure the eager loops above call the module-level `make_publish_fn`.

(d) In `on_connect` (after the `write/#` + `read/#` block at lines 109-111), subscribe the new wildcard. The existing `write/#` and `read/#` subscriptions are gated behind `if _char_subscribed:` because those topics only carry traffic during an active GATT session. The `subscribe/#` wildcard is deliberately placed OUTSIDE that guard, which is an intentional asymmetry: the host publishes `subscribe/<uuid>` immediately after consuming the `connected` event, so on a host-initiated connect the command can race the firmware's own per-session `write/#`/`read/#` (re)subscribe. Subscribing the idle `subscribe/#` wildcard once at MQTT connect removes that race window with no downside (the topic carries no traffic until a connect happens, so it adds at most one idle subscription per MQTT reconnect). A one-line code comment MUST record this rationale so the asymmetry is not "fixed" away later:

```python
    # Subscribe the per-char notify-enable wildcard unconditionally (NOT gated on
    # _char_subscribed like write/# and read/#): the host publishes subscribe/<uuid>
    # right after the connected event, so gating it would reintroduce an ordering
    # race. The topic is idle until a GATT connect happens (#231).
    await client_ref.subscribe(topic("subscribe/#"), 0)
```

(e) In the main loop (lines 604-610), add the `subscribe/<uuid>` dispatch branch BEFORE the `write/`/`read/` branches (order among the three does not matter because the prefixes are distinct, but keep it adjacent for readability):

```python
                elif t.startswith(topic("subscribe/")):
                    uuid_str = t[len(topic("subscribe/")):]
                    await handle_subscribe(uuid_str)
```

- [ ] **Step 4: Run the lazy class + the full firmware suite**

Run (bash):
```bash
python -m unittest firmware.tests.test_auto_connect.TestLazyNotifyEnable -v
python -m unittest discover -s firmware/tests -v 2>&1 | grep -E "^Ran|^OK|^FAILED"
```
Expected: `TestLazyNotifyEnable` PASSES (6 tests). Full suite: `Ran 87 tests` and `OK` (81 after Task 1 + 6 new). The IRQ/discovery tests in `test_connect_irq.py` are unaffected (they never set `_lazy_notify`, so the real `ble_bridge` path is exercised only for discovery, not notify).

- [ ] **Step 5: Firmware gate + commit**

```bash
taskkill //F //IM node.exe 2>/dev/null || true
python -m py_compile firmware/main.py
git add firmware/main.py firmware/tests/test_auto_connect.py
git commit -m "fix(firmware): enable proxy notify lazily on per-char subscribe command (#231)"
```
Expected: `py_compile` clean; commit succeeds. The firmware now: eager by default (old host, every existing test), lazy + command-driven when `lazy_notify` is advertised. No host change yet, so the live proxy is still eager.

---

## Task 3: Host publishes the `lazy_notify` capability flag in the config payload

Add `lazy_notify: true` to the config payload the host already publishes at startup. Host-only commit. With Task 1+2 firmware deployed this flips the firmware into lazy mode; with old firmware it is ignored. This commit alone (new host + new firmware) would make the firmware lazy WITHOUT yet sending the per-char command, so it MUST be followed immediately by Task 4 in the same review/push. Within the test suite this is safe because the host tests do not run real firmware; only the `publishConfig` payload assertions change.

**Files:**
- Modify: `src/ble/handler-mqtt-proxy/display.ts` (`publishConfig` adds `payload.lazy_notify = true`)
- Modify: `tests/ble/handler-mqtt-proxy.test.ts` (update the `publishConfig` payload assertions)

**Interfaces:**
- Consumes: nothing new.
- Produces: every config publish now includes `lazy_notify: true` in the JSON payload.

- [ ] **Step 1: Update the failing tests (payload now includes the flag)**

In `tests/ble/handler-mqtt-proxy.test.ts`, the `describe('publishConfig', ...)` block (lines 721-760) and `describe('publishConfig with users', ...)` (lines 814-847) assert exact serialized payloads. Update each expected payload to include `lazy_notify: true`. Concretely:

- `'publishes scale MACs with retain flag'`: change the expected payload to `JSON.stringify({ scales: ['ED:67:39:4B:27:FC'], lazy_notify: true })`.
- `'publishes empty scales array'`: `JSON.stringify({ scales: [], lazy_notify: true })`.
- `'includes autoConnect:false when auto_connect is disabled'`: `JSON.stringify({ scales: ['AA:BB:CC:DD:EE:FF'], autoConnect: false, lazy_notify: true })`.
- `'omits autoConnect field when auto_connect is true (default)'`: unchanged assertion shape (it only checks `autoConnect` is absent); ADD `expect(parsed.lazy_notify).toBe(true);` so the flag is positively pinned.
- `'includes users in config payload when provided'`: `JSON.stringify({ scales: ['AA:BB:CC:DD:EE:FF'], users, lazy_notify: true })`.
- `'omits users key when users array is empty'`: `JSON.stringify({ scales: ['AA:BB:CC:DD:EE:FF'], lazy_notify: true })`.
- `'omits users key when not provided'`: unchanged (it asserts `not.toHaveProperty('users')`); ADD `expect(payload.lazy_notify).toBe(true);`.

Canonical key-order pin: `JSON.stringify` serializes keys in INSERTION order, and `publishConfig` (`display.ts:23-33`) inserts in exactly this order: `scales` (always), then `users` (only if non-empty), then `autoConnect: false` (only if `auto_connect === false`), then (new, Step 3) `lazy_notify: true` (always, LAST). The canonical full order is therefore `scales, users?, autoConnect?, lazy_notify`. Every `JSON.stringify(...)` equality above MUST list its present keys in that order or the exact-string compare fails. Re-verify each expected literal against this order before running. There is currently no single test that combines `auto_connect: false` AND `users`; if one is ever added, its expected string must be `JSON.stringify({ scales, users, autoConnect: false, lazy_notify: true })` in that exact order.

Brittleness reduction: prefer converting the most fragile exact-string equalities to `JSON.parse` + per-field checks, which the suite already does at lines 756-758 and 842-845. For example, rather than pinning the whole serialized string for `'includes users in config payload when provided'`, parse the payload and assert `expect(parsed.scales).toEqual([...])`, `expect(parsed.users).toEqual(users)`, and `expect(parsed.lazy_notify).toBe(true)`. This keeps the tests resilient to future key-order changes while still positively pinning the flag. Keep the `{ retain: true }` options-arg assertion (third arg to `publishAsync`) intact in every case.

Nearby tests that share the config payload shape but already tolerate the new key (no edit required, but re-run them): `registerScaleMac > 'publishes discovered MAC to config topic'` (line 763) uses `expect.stringContaining('FF:EE:DD:CC:BB:AA')`, which still passes; `setDisplayUsers > 'stores users ...'` (line 850) and `publishConfig with users > 'omits users key when not provided'` (line 839) already parse the payload with `JSON.parse` + field checks, which still pass. They are listed here so the executor runs the FULL `publishConfig`, `registerScaleMac`, and `setDisplayUsers` describe blocks, not only `-t publishConfig`, to confirm none of them regress on the new field.

Also add one explicit new test in the `publishConfig` block:

```typescript
    it('always advertises lazy_notify:true for #231 host-ordered notify', async () => {
      await publishConfig(MQTT_PROXY_CONFIG, ['AA:BB:CC:DD:EE:FF']);
      const payload = JSON.parse(
        (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string,
      );
      expect(payload.lazy_notify).toBe(true);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (bash):
```bash
taskkill //F //IM node.exe 2>/dev/null || true
npx vitest run tests/ble/handler-mqtt-proxy.test.ts -t publishConfig
```
Expected: FAIL. The exact-payload assertions mismatch (`lazy_notify` missing from the actual payload) and the new positive-pin test fails.

- [ ] **Step 3: Add `lazy_notify` to the config payload**

In `src/ble/handler-mqtt-proxy/display.ts` `publishConfig` (lines 22-33), after the `autoConnect` block and BEFORE the `publishAsync` call, add:

```typescript
    // Advertise host-ordered (lazy) notify enable so the firmware enables BLE
    // notify only on a per-char subscribe command, after the host has subscribed
    // to the MQTT notify topic. This closes the #231 QN/Renpho 0x12 kickoff race.
    // New firmware honors it; old firmware ignores it and stays eager.
    payload.lazy_notify = true;
```

This inserts the key last, matching the test key-order.

- [ ] **Step 4: Run the publishConfig tests + the full mqtt-proxy suite**

Run (bash):
```bash
npx vitest run tests/ble/handler-mqtt-proxy.test.ts
```
Expected: ALL PASS (the updated `publishConfig` assertions plus every existing flow). Running the whole file (not `-t publishConfig`) is intentional: the `registerScaleMac` and `setDisplayUsers` describe blocks read the SAME config payload and must stay green with the new `lazy_notify` key present. The seed-config test (`seeds ESP32 known-scale set with the configured scale_mac on start (#231)`, lines 1262-1279) only checks `payload.scales`, so it stays green.

- [ ] **Step 5: Host gate + commit**

```bash
taskkill //F //IM node.exe 2>/dev/null || true
npx tsc --noEmit && npm run lint && npx prettier --check src/ble/handler-mqtt-proxy/display.ts tests/ble/handler-mqtt-proxy.test.ts
git add src/ble/handler-mqtt-proxy/display.ts tests/ble/handler-mqtt-proxy.test.ts
git commit -m "fix(ble): advertise lazy_notify capability to ESP32 proxy (#231)"
```
Expected: tsc/lint/prettier clean; commit succeeds.

---

## Task 4: Host commands per-char notify enable after subscribing

Make `MqttBleChar.subscribe()` publish the per-char enable command AFTER subscribing to `notify/<uuid>` and registering its handler. Host-only commit. This is the keystone: with Task 1-3 in place, the proxy is now race-free for QN, and old firmware (which ignores the command) is unchanged.

`MqttBleChar.subscribe` already owns `this.base` and `this.uuid` (the same fields it uses for the `notify`/`write`/`read` wire topics, `gatt.ts:8-12`), so the per-char command topic is built directly as `\`${this.base}/subscribe/${this.uuid}\``. We deliberately do NOT add a `subscribe` field to the `topics()` record: nothing would consume it (the publish is built from `this.base`, not from a passed `Topics` value), so it would be a dead field whose only coverage is a bespoke shape test. Keeping the publish derived from `this.base` keeps the diff strictly scoped to the fix and avoids an unused symmetric field.

**Files:**
- Modify: `src/ble/handler-mqtt-proxy/gatt.ts` (`MqttBleChar.subscribe` publishes the enable command)
- Modify: `tests/ble/handler-mqtt-proxy.test.ts` (assert the command is published after subscribe; add a notify-on-subscribe integration flow)

**Interfaces:**
- Consumes: `this.base`, `this.uuid`, `this.client.publishAsync`.
- Produces: a `publishAsync(\`${this.base}/subscribe/${this.uuid}\`, '')` call at the end of `MqttBleChar.subscribe`. The wire topic is `\`${base}/subscribe/<uuid>\``, which matches the firmware `topic("subscribe/<uuid>")` dispatch exactly.

- [ ] **Step 1: Write the failing tests**

The keystone test must model the actual #231 failure mode: a spontaneous firmware-triggered kickoff frame that arrives with NO central-initiated write. `createGattAdapter` is unsuitable as the SOLE proof because it declares `unlockCommand: [0xa5, 0x01]` (test fixture line 168) and a `charWriteUuid`. In legacy mode `subscribeAndInit` runs `subscribeToChar` and `startInit()` in parallel (`shared.ts:307-310`), and `startInit` fires the unlock write (`shared.ts:206-225`). So with `createGattAdapter` a write IS published during the test, and a frame delivered on `notify/<uuid>` could just as plausibly be the response to that write. That fixture can prove the subscribe command is published and ordered after the notify subscription, but it cannot prove the kickoff frame would have been LOST without the command.

To prove the lost-frame regression is actually guarded, add a dedicated notify-kickoff fixture with `charNotifyUuid`/`charWriteUuid` set but NO `unlockCommand`/`unlockCommands`. Legacy mode tolerates this: `initializeAdapter` requires the write char to EXIST (`shared.ts:194-197`) but returns early before any write when no unlock is configured (`shared.ts:199-201`), and the notify/write resolution in `subscribeAndInit` only checks that both chars exist (`shared.ts:286-300`). With no unlock the ONLY possible frame trigger is the firmware-side notify enable driven by the `subscribe/<uuid>` command, so if the command is not published the reading times out.

Add the fixture next to `createGattAdapter` (after test fixture line 182):

```typescript
/**
 * Notify-kickoff adapter modeling the #231 QN/Renpho ES-CS20M failure mode: the
 * scale emits its spontaneous 0x12 kickoff frame the instant its notify CCCD is
 * written, with NO central-initiated write. No unlockCommand means legacy mode
 * sends no write, so the ONLY way a frame can arrive in the test is the
 * host-ordered subscribe/<uuid> command driving the firmware notify enable.
 */
function createNotifyKickoffAdapter(name = 'KickoffScale'): ScaleAdapter {
  let reading: ScaleReading | null = null;
  return {
    name,
    charNotifyUuid: GATT_NOTIFY_UUID,
    charWriteUuid: GATT_WRITE_UUID, // must exist for legacy resolution, but no unlock is sent
    matches: vi.fn((info: BleDeviceInfo) => info.localName === name),
    parseNotification: vi.fn((data: Buffer) => {
      if (data.length >= 4) {
        reading = { weight: data.readUInt16LE(0) / 100, impedance: data.readUInt16LE(2) };
        return reading;
      }
      return null;
    }),
    isComplete: vi.fn(() => reading !== null && reading.impedance > 0),
    computeMetrics: vi.fn(() => BODY_COMP),
  };
}
```

In `tests/ble/handler-mqtt-proxy.test.ts`, add to the `describe('GATT proxy', ...)` block two tests. The first is the keystone: it uses `createNotifyKickoffAdapter` and delivers the frame ONLY in response to the `subscribe/<uuid>` publish (no write is ever sent by the adapter), so a regression that drops the command makes `nextReading()` time out. It also pins that the command is ordered AFTER the notify subscription. The second (secondary) reuses `createGattAdapter` and asserts a write-only char never gets a subscribe command.

```typescript
    it('enables notify on subscribe command for a write-less kickoff scale (#231 host-ordered)', async () => {
      // No unlockCommand on this fixture, so legacy mode sends NO write. The
      // frame can ONLY arrive because the host published subscribe/<uuid> and
      // the firmware enabled BLE notify in response. A regression that drops the
      // command leaves nextReading() to time out -> the test fails loudly.
      const adapter = createNotifyKickoffAdapter();
      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter], undefined, PROFILE);
      await watcher.start();

      // Record the order of subscribeAsync(notify) vs publishAsync(subscribe).
      const order: string[] = [];
      const origSub = mockClient.subscribeAsync;
      mockClient.subscribeAsync = vi.fn(async (topic: string, opts?: unknown) => {
        if (topic === `${PREFIX}/notify/${GATT_NOTIFY_UUID}`) order.push(`sub:${topic}`);
        return origSub(topic, opts as never);
      });
      const origPublish = mockClient.publishAsync;
      let writeSeen = false;
      mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
        if (topic === `${PREFIX}/write/${GATT_WRITE_UUID}`) writeSeen = true;
        if (topic === `${PREFIX}/subscribe/${GATT_NOTIFY_UUID}`) {
          order.push(`pub:${topic}`);
          // Firmware enables notify on the subscribe command, then the scale
          // emits its spontaneous kickoff frame on notify/<uuid> (no host write).
          queueMicrotask(() => {
            const buf = Buffer.alloc(4);
            buf.writeUInt16LE(7250, 0); // 72.50 kg
            buf.writeUInt16LE(505, 2); // impedance 505
            mockClient._simulateMessage(`${PREFIX}/notify/${GATT_NOTIFY_UUID}`, buf);
          });
        }
        return origPublish(topic, payload);
      });

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
      expect(raw.reading.weight).toBe(72.5);
      expect(raw.reading.impedance).toBe(505);
      // The fixture sends no unlock, so no write was ever published. The frame
      // could only have come from the subscribe-driven notify enable.
      expect(writeSeen).toBe(false);

      // The enable command MUST be published, and AFTER the notify subscription.
      const subscribeCmds = (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === `${PREFIX}/subscribe/${GATT_NOTIFY_UUID}`,
      );
      expect(subscribeCmds).toHaveLength(1);
      const subIdx = order.indexOf(`sub:${PREFIX}/notify/${GATT_NOTIFY_UUID}`);
      const pubIdx = order.indexOf(`pub:${PREFIX}/subscribe/${GATT_NOTIFY_UUID}`);
      expect(subIdx).toBeGreaterThanOrEqual(0);
      expect(pubIdx).toBeGreaterThan(subIdx);
    });

    it('does not publish a subscribe command for the write-only char (#231)', async () => {
      // Only notify chars are subscribed via char.subscribe, so only their
      // subscribe/<uuid> command is published. The write char is never subscribed.
      const adapter = createGattAdapter();
      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter], undefined, PROFILE);
      await watcher.start();

      const origPublish = mockClient.publishAsync;
      mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
        if (topic === `${PREFIX}/write/${GATT_WRITE_UUID}`) {
          queueMicrotask(() => {
            const buf = Buffer.alloc(4);
            buf.writeUInt16LE(9100, 0);
            buf.writeUInt16LE(515, 2);
            mockClient._simulateMessage(`${PREFIX}/notify/${GATT_NOTIFY_UUID}`, buf);
          });
        }
        return origPublish(topic, payload);
      });

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

      await watcher.nextReading();
      const writeSubscribeCmds = (
        mockClient.publishAsync as ReturnType<typeof vi.fn>
      ).mock.calls.filter((c: unknown[]) => c[0] === `${PREFIX}/subscribe/${GATT_WRITE_UUID}`);
      expect(writeSubscribeCmds).toHaveLength(0);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (bash):
```bash
taskkill //F //IM node.exe 2>/dev/null || true
npx vitest run tests/ble/handler-mqtt-proxy.test.ts -t "#231 host-ordered"
```
Expected: FAIL. The notify-on-subscribe flow times out / never resolves because `MqttBleChar.subscribe` does not yet publish `subscribe/<uuid>`, so no frame is delivered; the ordering assertions also fail (no `pub:` entry).

- [ ] **Step 3: Publish the enable command at the end of `MqttBleChar.subscribe`**

In `src/ble/handler-mqtt-proxy/gatt.ts`, change `MqttBleChar.subscribe` (lines 14-24) to publish the per-char command AFTER the MQTT subscription is in place, BEFORE returning the unsubscribe closure:

```typescript
  async subscribe(onData: (data: Buffer) => void): Promise<() => void> {
    const topic = `${this.base}/notify/${this.uuid}`;
    const handler = (t: string, payload: Buffer) => {
      if (t === topic) onData(payload);
    };
    this.client.on('message', handler);
    await this.client.subscribeAsync(topic);
    // Ordering is the whole point of #231: the MQTT notify subscription and the
    // message handler are in place BEFORE we tell the firmware to enable BLE
    // notify, so the firmware-triggered kickoff frame (QN/Renpho 0x12) always has
    // a listener. New firmware enables notify on this command; old firmware (eager)
    // ignores it and behaves exactly as before.
    await this.client.publishAsync(`${this.base}/subscribe/${this.uuid}`, '');
    return () => {
      this.client.removeListener('message', handler);
    };
  }
```

The publish uses `this.base` and `this.uuid` directly (the same fields already used for `notify`/`write`/`read`), so no change to `topics.ts` is needed: the wire topic `\`${this.base}/subscribe/${this.uuid}\`` matches the firmware `topic("subscribe/<uuid>")` dispatch byte for byte.

- [ ] **Step 4: Run the new flow + the FULL host suite (no regressions)**

Run (bash):
```bash
taskkill //F //IM node.exe 2>/dev/null || true
npx vitest run tests/ble/handler-mqtt-proxy.test.ts
```
Expected: ALL PASS, including the two new #231 flows and EVERY existing flow. The existing autonomous and host-initiated flows still resolve a reading: they deliver their frame on `notify/<uuid>` in response to the host `write/<uuid>` publish, and the extra `subscribe/<uuid>` publish is inert in those mocks (no handler reacts to it). The `cleans up message listeners on timeout` test is unaffected (it never connects). If any timeout-based test slows, confirm the extra publish is awaited and resolves immediately in the mock (`publishAsync` returns `undefined`).

- [ ] **Step 5: Host gate + commit**

```bash
taskkill //F //IM node.exe 2>/dev/null || true
npx tsc --noEmit && npm run lint && npx prettier --check src/ble/handler-mqtt-proxy/gatt.ts tests/ble/handler-mqtt-proxy.test.ts
git add src/ble/handler-mqtt-proxy/gatt.ts tests/ble/handler-mqtt-proxy.test.ts
git commit -m "fix(ble): command host-ordered proxy notify enable after subscribe (#231)"
```
Expected: tsc/lint/prettier clean; commit succeeds. The QN/Renpho proxy race is now closed end to end.

---

## Task 5: Full cross-suite verification gate

**Files:** none (verification only).

- [ ] **Step 1: Run the entire host suite**

Run (bash):
```bash
taskkill //F //IM node.exe 2>/dev/null || true
npx tsc --noEmit && npm run lint && npm run format:check && npm test
```
Expected: tsc clean, lint clean, prettier `format:check` clean, and the full Vitest run green at the new baseline (~1817 prior + the new mqtt-proxy tests added here). No existing test edited except the `publishConfig` payload assertions (Task 3) which are required by the protocol change.

- [ ] **Step 2: Run the entire firmware suite**

Run (bash):
```bash
python -m unittest discover -s firmware/tests -v 2>&1 | grep -E "^Ran|^OK|^FAILED"
python -m py_compile firmware/main.py firmware/ble_bridge.py
```
Expected: `Ran 87 tests` and `OK` (76 baseline + 5 from Task 1 + 6 from Task 2); `py_compile` clean for both firmware files. `ble_bridge.py` is unchanged in this plan (no edits), but compiling it confirms the firmware tree is intact.

- [ ] **Step 3: Confirm the eager loops are gated and the command path exists**

This grep step is a convenience cross-check; the real gate is the new ordering test (Task 4 Step 1), which fails loudly if the command publish is missing. Use a literal-substring search (`grep -F`) for the gatt.ts publish so the `${...}` template tokens match verbatim with no regex/shell escaping pitfalls (the source line is `` `${this.base}/subscribe/${this.uuid}` ``).

Run (bash):
```bash
grep -n "if not _lazy_notify" firmware/main.py
grep -n "handle_subscribe\|subscribe/#\|topic(\"subscribe/\")" firmware/main.py
grep -nF '/subscribe/${this.uuid}' src/ble/handler-mqtt-proxy/gatt.ts
grep -n "lazy_notify" src/ble/handler-mqtt-proxy/display.ts firmware/main.py
```
Expected: two `if not _lazy_notify:` guards (one in `_auto_gatt_connect`, one in `handle_connect`); a `handle_subscribe` definition, a `subscribe/#` subscription in `on_connect`, and a `topic("subscribe/")` dispatch branch in the main loop; the `` `${this.base}/subscribe/${this.uuid}` `` publish in `gatt.ts`; `payload.lazy_notify = true` in `display.ts` and the `_lazy_notify` parse in `main.py`.

- [ ] **Step 4: Confirm only the intended files changed across the four commits**

`dev` is far ahead of `main`, so diff just this plan's commits (Task 1-4 = 4 commits: firmware flag, firmware lazy, host flag, host command):

```bash
git diff --name-only HEAD~4..HEAD
```
Expected exactly:
```
firmware/main.py
firmware/tests/test_auto_connect.py
src/ble/handler-mqtt-proxy/display.ts
src/ble/handler-mqtt-proxy/gatt.ts
tests/ble/handler-mqtt-proxy.test.ts
```
(`firmware/main.py` and `tests/ble/handler-mqtt-proxy.test.ts` appear once each in the union even though they were touched by two commits.) `topics.ts` is NOT in the list: the per-char command topic is built directly from `this.base`/`this.uuid` in `gatt.ts`, so no topic-record change is needed (see Task 4). The plan markdown stays untracked and never appears. Do NOT push; the orchestrator pushes after review. Do NOT close #231.

---

## Self-Review

**1. Spec coverage.** Lazy host-ordered notify enable matching native semantics: host publishes `subscribe/<uuid>` AFTER `subscribeAsync(notify)` + handler registration (Task 4 Step 3), firmware enables notify only on that command (Task 2). Eager loops removed in BOTH `_auto_gatt_connect` and `handle_connect`, gated behind `if not _lazy_notify` (Task 2 Step 3 b/c). The per-char command topic is built directly from `this.base`/`this.uuid` in `gatt.ts`, so no `topics()`-record change is needed (the field would have been dead). Firmware subscribes `subscribe/#` in `on_connect` and dispatches in the main loop next to write/read (Task 2 Step 3 d/e). Backward compatibility via capability negotiation on the existing config topic, with the new-firmware + old-host fallback to eager (Task 1 + Task 3), justified over the grace alternative in Background. Autonomous CONNECT stays on the ESP32; only the per-char enable is host-ordered (one round-trip after connect). Tests on both sides with a failing test first in every code task. Both CI gates referenced and run.

**2. Backward-compat resolution (explicit).** Chosen: Option 1, capability negotiation via `lazy_notify` on the retained config topic. New host + new firmware: host advertises the flag, firmware goes lazy, host commands enable after subscribe -> race-free. New firmware + old host: no flag -> firmware stays eager -> identical to today, no regression. Old firmware + new host: firmware ignores the flag and the `subscribe/<uuid>` command (no handler), stays eager -> still racy for QN but no worse than today. The retained config guarantees the flag reaches the firmware before any autonomous connect.

**3. Commit ordering keeps both suites green at every commit.** Task 1 (firmware flag, default off) changes nothing observable. Task 2 (firmware lazy path) is exercised only by tests that set `_lazy_notify=True`; the default-off path keeps every existing firmware test eager and green, and no committed host sends the flag yet. Task 3 (host advertises the flag) only changes the `publishConfig` payload assertions in the host suite. Task 4 (host command) adds the publish that the new host-ordered tests need; existing host flows are inert to the extra publish. No commit leaves the proxy broken for the existing suites.

**4. Placeholder scan.** No TBD/TODO/"handle edge cases"/"similar to". Every code step shows the full edit and the exact surrounding anchor (line ranges verified against the current files). UUID literals are the base-UUID 32-hex forms `_norm_uuid` produces, matching the existing firmware tests.

**5. Type and contract consistency.** Host: `MqttBleChar.subscribe` publishes `\`${this.base}/subscribe/${this.uuid}\`` (the same `base`/`uuid` it already uses for `notify`/`write`/`read`), so the wire topic matches the firmware `topic("subscribe/<uuid>")` exactly with no `topics()`-record change. The keystone host test (Task 4 Step 1) uses a dedicated `createNotifyKickoffAdapter` with NO `unlockCommand`, so legacy mode sends no write (`shared.ts:199-201`) and the ONLY possible frame trigger is the subscribe-driven notify enable; a regression that drops the command makes `nextReading()` time out. Firmware: `handle_subscribe(uuid_str)` and both eager loops call the single hoisted `make_publish_fn`, whose `publish_fn(_source_uuid, data)` shape is unchanged from today; `bridge.start_notify(uuid, fn)` already exists and is unchanged. The recording-bridge and noop-client doubles in the firmware test model only the surface the connect handlers touch (`stop_streaming`/`start_streaming`/`disconnect`/`connect`/`start_notify`/`set_on_disconnect` and `subscribe`/`publish`, the latter two RECORDING their topics so the on_connect `subscribe/#` subscription and the lazy-mode `connected` publish are positively pinned), and the test sets `_char_subscribed=True` + `CONTINUOUS_SCAN=False` to skip the wildcard-subscribe and streaming branches that need a real client/bridge.

**6. No regression on S3/PSRAM or non-QN proxy paths.** The change is purely the notify-enable ordering; discovery, connect, addr-type probing, IDF-heap guard, and the disconnect/scan resume logic are untouched. Central-initiated (write-first) scales still get their notify enabled (the host subscribes to their notify char during `subscribeAndInit`/`onConnected`, which now also enables BLE notify via the command before the first unlock write), so they are unaffected. The `firmware/ble_bridge.py` connect/discovery path and its tests are not modified.
