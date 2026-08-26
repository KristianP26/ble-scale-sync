# ESP32 Autonomous GATT Discovery async-for Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `TypeError: coroutine expected` that strands the ESP32 autonomous GATT connect during service discovery (#231 retest #6), by driving aioble's async-iterator discovery with `async for` under a single real wall-clock timeout.

**Architecture:** `BleBridge.connect()` in `firmware/ble_bridge.py` succeeds at the aioble `device.connect()` step (the #231 addr_type fix landed), then calls `asyncio.wait_for(self._conn.services(), 10)`. aioble's `connection.services()` and `service.characteristics()` return `ClientDiscover` async iterators, not coroutines, so `wait_for` (which wraps its argument in `create_task`) raises `TypeError: coroutine expected`. The fix iterates with `async for`. Because aioble's per-call `timeout_ms` is an unimplemented TODO (`ClientDiscover.__anext__` awaits an IRQ `ThreadSafeFlag` with no timeout), the whole discovery is wrapped in one `asyncio.wait_for` to preserve a real stall guard, and the `except` is broadened so any discovery fault disconnects and fails fast instead of bubbling an uncaught error into the `main.py` auto-connect retry storm.

**Tech Stack:** MicroPython v1.24.x, aioble (micropython-lib, no independent version), CPython `unittest` for host-runnable firmware tests (`python -m unittest discover -s firmware/tests`, run in CI `ci.yml`).

## Global Constraints

- No em dash or double dash anywhere (commit, code, comments, docs).
- ES Modules / Prettier / ESLint rules apply to TS only; this change is Python (firmware) plus a Python test. No TS touched.
- Firmware tests must stay host-runnable under CPython `unittest` (no real `bluetooth`/`aioble`/`board` on the host; they are stubbed in `sys.modules`).
- Conventional Commit messages (`fix(firmware): ...`), reference `#231`.
- NEVER `git add -A` in this repo (it stages untracked `docs/superpowers/plans/*.md`). Use explicit `git add <files>`.
- aioble fact (verified against micropython-lib `aioble/client.py`): `connection.services(uuid=None, timeout_ms=2000)` and `service.characteristics(uuid=None, timeout_ms=2000)` return `ClientDiscover` async iterators driven with `async for`; `connection.service(uuid)` / `service.characteristic(uuid)` are coroutines returning one match or `None`. `ClientDiscover.__anext__` awaits `self._event.wait()` with no timeout (`timeout_ms` is a stored-but-unused TODO), so aioble enforces no discovery timeout of its own.

---

### Task 1: Correct the aioble discovery mock and add the discovery regression test

The current `_FakeConn.services()` in `firmware/tests/test_connect_irq.py` is `async def services(self): return []` — a coroutine returning a list. That is the exact wrong shape the production bug assumes, so the existing tests pass against broken code. Switching production to `async for` would break `async for ... in <coroutine>`. So the mock must first be corrected to model aioble's async-iterator contract, which simultaneously turns the existing `connect()` tests into real regression coverage and lets us assert discovery actually yields characteristics.

**Files:**
- Modify: `firmware/tests/test_connect_irq.py` (replace the `_FakeConn` definition near lines 56-65; add helper fakes and one new test class)
- Test: `firmware/tests/test_connect_irq.py` (this file IS the test)

**Interfaces:**
- Consumes: `ble_bridge.BleBridge` (real import already wired in this file), the `_bt.FLAG_*` constants already stubbed (`FLAG_READ=0x02`, `FLAG_WRITE=0x08`, `FLAG_NOTIFY=0x10`, `FLAG_WRITE_NO_RESPONSE=0x04`, `FLAG_INDICATE=0x20`), `_norm_uuid` behavior (a plain string `uuid` falls through to `str(uuid).lower().replace('-', '')`).
- Produces: `_AsyncDiscover` (async iterator helper), `_FakeChar`, `_FakeService`, an updated `_FakeConn` whose `services()` returns an EMPTY `_AsyncDiscover` (preserves every existing `{"chars": []}` assertion), and `_FakeConnWithChars` used only by the new test.

- [ ] **Step 1: Write the failing test (and corrected mock) — replace the `_FakeConn` block**

In `firmware/tests/test_connect_irq.py`, replace the existing block:

```python
class _FakeConn:
    async def services(self):
        return []

    async def disconnect(self):
        pass

    def is_connected(self):
        return True
```

with:

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

Then append a new test class at the end of the file, before the `if __name__ == "__main__":` guard:

```python
class TestConnectDiscoversCharsViaAsyncFor(unittest.IsolatedAsyncioTestCase):
    """connect() must drive aioble's async-iterator services()/characteristics()
    with `async for`. Wrapping the iterator in asyncio.wait_for raised
    'TypeError: coroutine expected' and stranded the autonomous connect (#231)."""

    async def test_discovery_yields_mapped_characteristics(self):
        conn = _FakeConnWithChars()

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
                "0000fff200001000800000805f9b34fb",
            ],
        )
        # Property bitmask -> string list mapping is preserved.
        by_uuid = {c["uuid"]: c["properties"] for c in result["chars"]}
        self.assertEqual(
            sorted(by_uuid["0000fff100001000800000805f9b34fb"]),
            ["notify", "read"],
        )
        self.assertEqual(
            by_uuid["0000fff200001000800000805f9b34fb"],
            ["write-without-response"],
        )
        # The discovered chars are cached on the bridge for start_notify().
        self.assertIn("0000fff100001000800000805f9b34fb", bridge._chars)
```

NOTE on the expected uuid strings: `_norm_uuid("0000fff1-0000-1000-8000-00805f9b34fb")` hits the fallthrough `s.lower().replace("-", "")`, which removes the 4 dashes from the 36-char canonical UUID and yields the 32-char `0000fff100001000800000805f9b34fb` (likewise `...fff2...` -> `0000fff200001000800000805f9b34fb`). These literals are hardcoded in the assertions above. The contract under test is "async for drives discovery and properties map"; the normalization is incidental but pinned so the test fails loudly if `_norm_uuid` ever changes.

- [ ] **Step 2: Run the new test against the UNMODIFIED production code to verify it fails**

Kill node first per repo rule, then run only the new test:

```bash
taskkill //F //IM node.exe 2>/dev/null || true
python -m unittest firmware.tests.test_connect_irq.TestConnectDiscoversCharsViaAsyncFor -v
```

Expected: FAIL. Against the current `await asyncio.wait_for(self._conn.services(), 10)`, `self._conn.services()` now returns an `_AsyncDiscover` (async iterator), which `wait_for` feeds to `create_task`, raising `TypeError: coroutine expected`. Also expect the existing `TestConnectRestoresAiobleIrq` / `TestConnectFallbackTriesOppositeType` to now FAIL for the same reason (their `_FakeConn.services()` is no longer a coroutine) — this is expected and is fixed in Task 2. If the produced uuid string differs from the assertion, note the actual value from the failure output for Step 1's NOTE.

- [ ] **Step 3: Commit the test + mock correction**

```bash
git add firmware/tests/test_connect_irq.py
git commit -m "test(firmware): model aioble async-iterator discovery in connect mock (#231)"
```

---

### Task 2: Drive discovery with async for under one wall-clock timeout

**Files:**
- Modify: `firmware/ble_bridge.py:465-492` (the `self._chars = {}` ... `return {"chars": chars_info}` block inside `connect()`)

**Interfaces:**
- Consumes: `self._conn` (aioble `DeviceConnection` from `device.connect()`), `self._chars` dict, module-level `_norm_uuid`, `bluetooth.FLAG_*`, `asyncio` (imported at `firmware/ble_bridge.py:8`), `address` local (the MAC string already in scope in `connect()`).
- Produces: unchanged return contract `{"chars": [{"uuid": str, "properties": [str, ...]}, ...]}` and the side effect of populating `self._chars[uuid_str] = char`.

- [ ] **Step 1: Replace the discovery block**

In `firmware/ble_bridge.py`, replace this exact block (currently lines 465-492):

```python
        self._chars = {}
        chars_info = []

        try:
            services = await asyncio.wait_for(self._conn.services(), 10)
            for service in services:
                chars = await asyncio.wait_for(service.characteristics(), 10)
                for char in chars:
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
        except asyncio.TimeoutError:
            print(f"Service discovery timed out for {address}")
            await self.disconnect()
            raise

        return {"chars": chars_info}
```

with:

```python
        self._chars = {}

        # aioble's services()/characteristics() return ClientDiscover async
        # iterators, not coroutines, so they must be driven with `async for`.
        # Wrapping them in asyncio.wait_for() called create_task() on a
        # non-coroutine and raised "TypeError: coroutine expected", which
        # escaped the timeout handler and stranded the autonomous connect in
        # main.py's retry loop (#231). aioble's own per-call timeout_ms is an
        # unimplemented TODO (ClientDiscover.__anext__ waits on an IRQ flag with
        # no timeout), so one asyncio.wait_for around the whole discovery is
        # what actually bounds a stalled peer.
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

        try:
            chars_info = await asyncio.wait_for(_discover_chars(), 10)
        except asyncio.TimeoutError:
            print(f"Service discovery timed out for {address}")
            await self.disconnect()
            raise
        except Exception as e:
            print(f"Service discovery failed for {address}: {type(e).__name__}: {e}")
            await self.disconnect()
            raise

        return {"chars": chars_info}
```

- [ ] **Step 2: Run the full firmware test suite**

```bash
taskkill //F //IM node.exe 2>/dev/null || true
python -m unittest discover -s firmware/tests -v
```

Expected: PASS for all of `test_connect_irq.py` (the corrected mock now matches `async for`), plus the new `TestConnectDiscoversCharsViaAsyncFor`, plus `test_auto_connect.py`, `test_ad_parser.py`, `test_board_config.py` unaffected. Total: all tests OK.

- [ ] **Step 3: Commit the production fix**

```bash
git add firmware/ble_bridge.py
git commit -m "fix(firmware): drive aioble GATT discovery with async for (#231)"
```

---

### Task 3: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Re-run firmware tests and confirm count**

```bash
taskkill //F //IM node.exe 2>/dev/null || true
python -m unittest discover -s firmware/tests -v 2>&1 | tail -5
```

Expected: `OK` with the firmware test count incremented by exactly 1 new test method vs the pre-change baseline.

- [ ] **Step 2: Sanity-check no JS/TS was touched (so the npm suite is not implicated)**

`dev` is far ahead of `main` (unreleased work), so do NOT diff against `main`. Diff the two commits this plan created:

```bash
git diff --name-only HEAD~2..HEAD
```

Expected: exactly two files, `firmware/ble_bridge.py` and `firmware/tests/test_connect_irq.py`. The plan md stays UNTRACKED (repo rule) and so never appears in `git diff`.

- [ ] **Step 3: Confirm the production block has no remaining `wait_for` over a raw `services()`/`characteristics()` call**

```bash
grep -n "wait_for" firmware/ble_bridge.py
```

Expected: exactly one match, `await asyncio.wait_for(_discover_chars(), 10)` (the wrapper coroutine), and zero matches wrapping `self._conn.services()` or `service.characteristics()` directly.

---

## Self-Review

**1. Spec coverage:** Option A (correct async-for API) — Task 2 Step 1. Real wall-clock timeout despite aioble's no-op `timeout_ms` — Task 2 Step 1 (`asyncio.wait_for(_discover_chars(), 10)`). Option C (broadened except, disconnect + fail fast) — Task 2 Step 1 (`except Exception`). Test correctness (mock no longer encodes the bug) — Task 1. Regression coverage proving discovery works — Task 1 new test. Verification — Task 3. All covered.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every code step shows full code. The one deferred value (exact normalized uuid string) has an explicit run-and-copy instruction with rationale, not a placeholder.

**3. Type consistency:** `_discover_chars` returns `chars_info` (list of `{"uuid", "properties"}`), consumed by `return {"chars": chars_info}` — matches `connect()`'s existing contract and `main.py:224` `for char_info in result["chars"]`. Mock `_AsyncDiscover`/`_FakeService.characteristics()`/`_FakeConn.services()` all return the async-iterator type the production `async for` consumes. `_FakeChar.properties` is an int bitmask matching the `char.properties &` usage. Consistent.
