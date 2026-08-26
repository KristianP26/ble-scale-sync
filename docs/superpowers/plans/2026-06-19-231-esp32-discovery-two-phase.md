# ESP32 Autonomous GATT Discovery Two-Phase Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `ValueError: Discovery in progress` that strands the ESP32 autonomous GATT connect during service discovery (#231 retest #7), by draining aioble's `services()` iterator fully before discovering each service's characteristics.

**Architecture:** The previous fix (`async for` discovery wrapped in one `asyncio.wait_for`, commit c943e11) correctly resolved the `TypeError: coroutine expected` but wrote the iteration as `async for char in service.characteristics()` nested INSIDE `async for service in self._conn.services()`. aioble enforces a single in-flight discovery per connection via one `connection._discover` slot: `ClientDiscover._start()` raises `ValueError("Discovery in progress")` if the slot is already owned, and the slot is only released when an iterator is exhausted (`StopAsyncIteration` sets `_discover = None`). Because the outer `services()` iterator is not exhausted while we are mid-loop, starting the inner `characteristics()` discovery hits the occupied slot and raises. The fix is the two-phase pattern aioble itself uses (its `service()`/`characteristic()` coroutines drain `services()` before use): collect all services into a list first (which exhausts the iterator and frees the slot), then iterate each collected service's `characteristics()` sequentially (each one claims and releases the slot in turn).

**Tech Stack:** MicroPython v1.24.x, aioble (micropython-lib, no independent version), CPython `unittest` for host-runnable firmware tests (`python -m unittest discover -s firmware/tests`, run in CI `ci.yml`).

## Global Constraints

- No em dash or double dash anywhere (commit, code, comments, docs).
- This change is Python (firmware) plus a Python test only. No TS touched; the npm/vitest suite is not implicated.
- Firmware tests stay host-runnable under CPython `unittest` (no real `bluetooth`/`aioble`/`board` on the host; they are stubbed in `sys.modules`).
- Conventional Commit messages (`fix(firmware): ...`, `test(firmware): ...`), reference `#231`.
- NEVER `git add -A` in this repo (it stages untracked `docs/superpowers/plans/*.md`). Use explicit `git add <files>`.
- aioble facts (verified against micropython-lib `aioble/client.py` and `aioble/device.py`): `DeviceConnection.services(uuid=None, timeout_ms=2000)` returns a `ClientDiscover` async iterator; `service.characteristics(uuid=None, timeout_ms=2000)` likewise; `DeviceConnection.service(uuid)` and `ClientService.characteristic(uuid)` are coroutines that internally drain the matching iterator. `DeviceConnection.__init__` sets `self._discover = None`; `ClientDiscover._start` raises `ValueError("Discovery in progress")` when `self._connection._discover` is already set; `ClientDiscover.__anext__` clears `self._connection._discover = None` on `StopAsyncIteration`. `disconnect()` does NOT reset `_discover`, but each `device.connect()` yields a fresh `DeviceConnection`, so the bug is per-connection deterministic (nested discovery), not leaked state.

---

### Task 1: Make the discovery mock model aioble's single discovery slot, and add the ordering regression tests

The current `_AsyncDiscover` mock in `firmware/tests/test_connect_irq.py` is a plain async iterator with no shared discovery slot, so it cannot reproduce `Discovery in progress` and the existing `test_discovery_yields_mapped_characteristics` passes even against the buggy nested production code. Upgrading the mock to model aioble's single per-connection `_discover` slot turns that existing test into a true red reproducer (nested discovery raises) and lets a new test guard that the slot is released between multiple services.

**Files:**
- Modify: `firmware/tests/test_connect_irq.py` (replace the mock class block currently at lines 56-120; add one new test method to the existing `TestConnectDiscoversCharsViaAsyncFor` class)

**Interfaces:**
- Consumes: `ble_bridge.BleBridge` (real import already wired), the `_bt.FLAG_*` constants already stubbed (`FLAG_READ=0x02`, `FLAG_WRITE=0x08`, `FLAG_NOTIFY=0x10`, `FLAG_WRITE_NO_RESPONSE=0x04`, `FLAG_INDICATE=0x20`), `_norm_uuid` (plain-string input falls through to `str(uuid).lower().replace('-', '')`), the existing `_aioble.Device` swap pattern.
- Produces: `_DiscoveryState` (one-slot model), a slot-aware `_AsyncDiscover(state, items)`, `_FakeChar`, `_FakeService(state, chars)`, `_FakeConn` (empty services, preserves existing `{"chars": []}` assertions), `_FakeConnWithChars` (one service, two chars), `_FakeConnTwoServices` (two services, one char each).

- [ ] **Step 1: Replace the mock class block**

In `firmware/tests/test_connect_irq.py`, replace this exact block (currently lines 56-120, from `class _AsyncDiscover:` through the end of `class _FakeConnWithChars:`):

```python
class _AsyncDiscover:
    """Models aioble's ClientDiscover: an async iterator (async for), NOT a
    coroutine. The production bug was wrapping this object in asyncio.wait_for,
    which calls create_task and raises 'TypeError: coroutine expected' (#231)."""

    def __init__(self, items):
        self._items = list(items)
        self._i = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._i >= len(self._items):
            raise StopAsyncIteration
        item = self._items[self._i]
        self._i += 1
        return item


class _FakeChar:
    def __init__(self, uuid, properties):
        self.uuid = uuid
        self.properties = properties


class _FakeService:
    def __init__(self, chars):
        self._chars = chars

    def characteristics(self):
        # aioble returns an async iterator here, not a coroutine.
        return _AsyncDiscover(self._chars)


class _FakeConn:
    def services(self):
        # aioble returns an async iterator here, not a coroutine. Empty by
        # default so the IRQ/addr-type tests keep asserting {"chars": []}.
        return _AsyncDiscover([])

    async def disconnect(self):
        pass

    def is_connected(self):
        return True


class _FakeConnWithChars:
    """A connection that discovers one service with two characteristics, used to
    prove connect() drives discovery via async for and maps properties (#231)."""

    def __init__(self):
        self.disconnected = False

    def services(self):
        notify_char = _FakeChar("0000fff1-0000-1000-8000-00805f9b34fb", _bt.FLAG_NOTIFY | _bt.FLAG_READ)
        write_char = _FakeChar("0000fff2-0000-1000-8000-00805f9b34fb", _bt.FLAG_WRITE_NO_RESPONSE)
        return _AsyncDiscover([_FakeService([notify_char, write_char])])

    async def disconnect(self):
        self.disconnected = True

    def is_connected(self):
        return True
```

with:

```python
class _DiscoveryState:
    """Models aioble's single per-connection `_discover` slot. aioble allows
    only one discovery (services OR characteristics) in flight per connection;
    starting a second while one is unfinished raises ValueError (#231 fix 8)."""

    def __init__(self):
        self.active = None


class _AsyncDiscover:
    """Models aioble's ClientDiscover: an async iterator (async for), NOT a
    coroutine. It claims the connection's single discovery slot on first
    iteration and releases it on exhaustion, mirroring aioble's _start /
    StopAsyncIteration handling. Wrapping it in asyncio.wait_for raised
    'TypeError: coroutine expected' (#231 fix 7); nesting two of them raised
    'ValueError: Discovery in progress' (#231 fix 8)."""

    def __init__(self, state, items):
        self._state = state
        self._items = list(items)
        self._i = 0
        self._started = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._started:
            if self._state.active is not None:
                raise ValueError("Discovery in progress")
            self._state.active = self
            self._started = True
        if self._i >= len(self._items):
            self._state.active = None
            raise StopAsyncIteration
        item = self._items[self._i]
        self._i += 1
        return item


class _FakeChar:
    def __init__(self, uuid, properties):
        self.uuid = uuid
        self.properties = properties


class _FakeService:
    def __init__(self, state, chars):
        self._state = state
        self._chars = chars

    def characteristics(self):
        # aioble returns an async iterator sharing the connection's single
        # discovery slot, not a coroutine.
        return _AsyncDiscover(self._state, self._chars)


class _FakeConn:
    def __init__(self):
        self._state = _DiscoveryState()

    def services(self):
        # aioble returns an async iterator here, not a coroutine. Empty by
        # default so the IRQ/addr-type tests keep asserting {"chars": []}.
        return _AsyncDiscover(self._state, [])

    async def disconnect(self):
        pass

    def is_connected(self):
        return True


class _FakeConnWithChars:
    """One service with two characteristics. Proves connect() drains services()
    before discovering characteristics; the slot-aware mock raises
    'Discovery in progress' if connect() nests the two discoveries (#231)."""

    def __init__(self):
        self.disconnected = False
        self._state = _DiscoveryState()

    def services(self):
        notify_char = _FakeChar("0000fff1-0000-1000-8000-00805f9b34fb", _bt.FLAG_NOTIFY | _bt.FLAG_READ)
        write_char = _FakeChar("0000fff2-0000-1000-8000-00805f9b34fb", _bt.FLAG_WRITE_NO_RESPONSE)
        service = _FakeService(self._state, [notify_char, write_char])
        return _AsyncDiscover(self._state, [service])

    async def disconnect(self):
        self.disconnected = True

    def is_connected(self):
        return True


class _FakeConnTwoServices:
    """Two services, each with one characteristic. Guards that the discovery
    slot is released between services, so characteristics() for the second
    service does not raise 'Discovery in progress' (#231 fix 8)."""

    def __init__(self):
        self.disconnected = False
        self._state = _DiscoveryState()

    def services(self):
        char_a = _FakeChar("0000fff1-0000-1000-8000-00805f9b34fb", _bt.FLAG_NOTIFY)
        char_b = _FakeChar("00002a9d-0000-1000-8000-00805f9b34fb", _bt.FLAG_READ)
        service_a = _FakeService(self._state, [char_a])
        service_b = _FakeService(self._state, [char_b])
        return _AsyncDiscover(self._state, [service_a, service_b])

    async def disconnect(self):
        self.disconnected = True

    def is_connected(self):
        return True
```

- [ ] **Step 2: Run the existing discovery test against UNMODIFIED production to verify it now reproduces the bug**

```bash
taskkill //F //IM node.exe 2>/dev/null || true
python -m unittest firmware.tests.test_connect_irq.TestConnectDiscoversCharsViaAsyncFor.test_discovery_yields_mapped_characteristics -v
```

Expected: ERROR (an unhandled `ValueError: Discovery in progress` propagates out of `connect()`'s `except Exception: ... raise`, so unittest reports it as `FAILED (errors=1)`, not an assertion failure). With the slot-aware mock, the current nested production code (`async for char in service.characteristics()` inside the unfinished `async for service in self._conn.services()`) starts a second discovery while the services slot is held. This is the retest #7 bug reproduced as a unit test.

- [ ] **Step 3: Add the two-service ordering test**

In `firmware/tests/test_connect_irq.py`, inside the existing `class TestConnectDiscoversCharsViaAsyncFor(...)`, add this method after `test_discovery_yields_mapped_characteristics`:

```python
    async def test_discovery_releases_slot_between_services(self):
        # Two services discovered sequentially: characteristics() for the second
        # service must not raise "Discovery in progress", i.e. connect() drains
        # services() fully before discovering any characteristics (#231 fix 8).
        conn = _FakeConnTwoServices()

        class _DeviceReturningConn:
            def __init__(self, addr_type, addr_bytes):
                self._addr_type = addr_type

            async def connect(self, timeout_ms=None, scan_duration_ms=None):
                return conn

        orig_device = _aioble.Device
        _aioble.Device = _DeviceReturningConn
        try:
            bridge = ble_bridge.BleBridge()
            result = await bridge.connect("84:FC:E6:53:06:1C", 0)
        finally:
            _aioble.Device = orig_device

        uuids = [c["uuid"] for c in result["chars"]]
        self.assertEqual(
            uuids,
            [
                "0000fff100001000800000805f9b34fb",
                "00002a9d00001000800000805f9b34fb",
            ],
        )
```

Note on the asserted literals: `_norm_uuid` removes the 4 dashes from the canonical 36-char UUID, producing the 32-char base-UUID form `0000XXXX00001000800000805f9b34fb`. So `0xfff1` -> `0000fff100001000800000805f9b34fb` and `0x2a9d` -> `00002a9d00001000800000805f9b34fb`. These are pinned; if `_norm_uuid` ever changes the test fails loudly.

- [ ] **Step 4: Commit the slot-aware mock + ordering tests**

```bash
git add firmware/tests/test_connect_irq.py
git commit -m "test(firmware): model aioble single discovery slot in connect mock (#231)"
```

---

### Task 2: Drain services() before discovering characteristics (two-phase)

**Files:**
- Modify: `firmware/ble_bridge.py:476-494` (the `_discover_chars` inner coroutine inside `connect()`)

**Interfaces:**
- Consumes: `self._conn` (aioble `DeviceConnection`), `self._chars` dict (reset to `{}` at line 465 before the closure), module-level `_norm_uuid`, `bluetooth.FLAG_*`.
- Produces: unchanged return contract `chars_info` = list of `{"uuid": str, "properties": [str, ...]}`, wrapped by the existing `return {"chars": chars_info}` at line 507 and the existing `asyncio.wait_for(_discover_chars(), 10)` at line 497.

- [ ] **Step 1: Replace the `_discover_chars` body**

In `firmware/ble_bridge.py`, replace this exact block (currently lines 476-494):

```python
        async def _discover_chars():
            chars_info = []
            async for service in self._conn.services():
                async for char in service.characteristics():
                    uuid_str = _norm_uuid(char.uuid)
                    self._chars[uuid_str] = char
                    props = []
                    if char.properties & bluetooth.FLAG_READ:
                        props.append("read")
                    if char.properties & bluetooth.FLAG_WRITE:
                        props.append("write")
                    if char.properties & bluetooth.FLAG_NOTIFY:
                        props.append("notify")
                    if char.properties & bluetooth.FLAG_WRITE_NO_RESPONSE:
                        props.append("write-without-response")
                    if char.properties & bluetooth.FLAG_INDICATE:
                        props.append("indicate")
                    chars_info.append({"uuid": uuid_str, "properties": props})
            return chars_info
```

with:

```python
        async def _discover_chars():
            chars_info = []
            # aioble allows only one discovery in flight per connection (a single
            # connection._discover slot), so the services() iterator must be
            # fully drained before any characteristics() discovery starts.
            # Nesting characteristics() inside the services() loop raised
            # "ValueError: Discovery in progress" (#231). Collect services first,
            # then discover characteristics per service (aioble's own pattern).
            services = []
            async for service in self._conn.services():
                services.append(service)
            for service in services:
                async for char in service.characteristics():
                    uuid_str = _norm_uuid(char.uuid)
                    self._chars[uuid_str] = char
                    props = []
                    if char.properties & bluetooth.FLAG_READ:
                        props.append("read")
                    if char.properties & bluetooth.FLAG_WRITE:
                        props.append("write")
                    if char.properties & bluetooth.FLAG_NOTIFY:
                        props.append("notify")
                    if char.properties & bluetooth.FLAG_WRITE_NO_RESPONSE:
                        props.append("write-without-response")
                    if char.properties & bluetooth.FLAG_INDICATE:
                        props.append("indicate")
                    chars_info.append({"uuid": uuid_str, "properties": props})
            return chars_info
```

- [ ] **Step 2: Run the full firmware test suite**

```bash
taskkill //F //IM node.exe 2>/dev/null || true
python -m unittest discover -s firmware/tests -v
```

Expected: all PASS, including `test_discovery_yields_mapped_characteristics` (now green: services drained before characteristics), `test_discovery_releases_slot_between_services`, the IRQ/addr-type tests (still assert `{"chars": []}` via the empty `_FakeConn`), and `test_auto_connect.py` / `test_ad_parser.py` / `test_board_config.py`. Total: 68 tests, `OK`.

- [ ] **Step 3: Commit the production fix**

```bash
git add firmware/ble_bridge.py
git commit -m "fix(firmware): drain aioble services before characteristic discovery (#231)"
```

---

### Task 3: Verification gate

**Files:** none (verification only).

- [ ] **Step 1: Confirm the suite count and OK**

```bash
taskkill //F //IM node.exe 2>/dev/null || true
python -m unittest discover -s firmware/tests -v 2>&1 | tail -3
```

Expected: `Ran 68 tests` and `OK`.

- [ ] **Step 2: Confirm the nested-discovery pattern is gone**

```bash
grep -nE "^\s+async for" firmware/ble_bridge.py
```

Expected: exactly two loop lines that are NOT nested directly inside each other: `async for service in self._conn.services():` (collecting into the list) and `async for char in service.characteristics():` (under the plain `for service in services:` loop). The anchored `^\s+` pattern excludes the explanatory comment on line 468 that contains the backticked phrase `async for` (a plain `grep -n "async for"` would match that comment too, returning three lines). Manually confirm the `characteristics()` loop is under `for service in services:`, not under the `services()` loop.

- [ ] **Step 3: Confirm only the two firmware files changed in this work**

`dev` is far ahead of `main`, so diff the commits this plan created (Task 1 + Task 2 = 2 commits):

```bash
git diff --name-only HEAD~2..HEAD
```

Expected: exactly `firmware/ble_bridge.py` and `firmware/tests/test_connect_irq.py`. The plan md stays untracked and never appears in `git diff`.

---

## Self-Review

**1. Spec coverage:** Two-phase discovery (drain services then characteristics) — Task 2. Mock that can reproduce `Discovery in progress` — Task 1 Step 1. Red reproducer — Task 1 Step 2 (existing test now fails on unmodified code). Slot-release-between-services guard — Task 1 Step 3 + `_FakeConnTwoServices`. Verification — Task 3. All covered.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every code step shows full code. The UUID literals are pinned with a checkable base-UUID rationale, not a run-and-copy placeholder.

**3. Type consistency:** `_AsyncDiscover(state, items)` and `_FakeService(state, chars)` take the shared `_DiscoveryState`; every constructor call (`_FakeConn`, `_FakeConnWithChars`, `_FakeConnTwoServices`) passes `self._state` to both its `services()` discover and its services' `characteristics()` discovers, so the slot is genuinely shared per connection. `_discover_chars` returns `chars_info` (list of `{"uuid","properties"}`), consumed by `return {"chars": chars_info}` and `main.py` `for char_info in result["chars"]`. `_FakeChar.properties` is an int bitmask matching `char.properties &`. The empty `_FakeConn` keeps the existing tests intact because the two-phase code drains zero services and returns an empty list: the one assertion of `result == {"chars": []}` (`test_opposite_type_tried_after_non_timeout_error`) plus the two IRQ/addr-type tests that construct the empty `_FakeConn` (asserting only on the captured IRQ handler and `addr_type`) all still pass. No empty-as-failure behavior is introduced in this plan; that known minor gap — a connect that publishes "0 chars" when the scale vanishes mid-discovery — is intentionally left out of scope to avoid churning those existing tests.
