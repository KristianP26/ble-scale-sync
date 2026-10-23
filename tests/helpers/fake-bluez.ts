/**
 * A model of bluetoothd's discovery state machine and the kernel scan below
 * it, for the node-ble discovery code. Transcribed from BlueZ 5.82
 * src/adapter.c, function by function, so a test can put BlueZ into the state
 * the maintainer's Pi was in and watch what our calls do to it:
 *
 * - per-sender clients, each either discovering (discovery_list) or holding a
 *   pre-set filter only (set_filter_list);
 * - `discovering` (the D-Bus Discovering property) and `enable`
 *   (discovery_enable, what bluetoothd believes the kernel is doing), kept
 *   separate from `kernelScanning`, what the kernel is really doing;
 * - current_discovery_filter, which outlives the last client, and
 *   filters_equal(), which compares transport only: DuplicateData is not part
 *   of the kernel filter;
 * - discovery_stop()'s local path when discovery_enable is 0;
 * - the kernel rejecting Stop Discovery while it is not scanning, which BlueZ
 *   turns into InProgress for the client that asked and leaves `discovering`
 *   set;
 * - start_discovery_timeout() sending Stop Discovery with no completion
 *   handler when discovery_enable is 1, which leaves a StartDiscovery
 *   unanswered for good;
 * - Powered off running adapter_stop(): every client and pending request
 *   dropped, Discovering and the current filter cleared, discovery_enable NOT
 *   touched.
 * - the kernel refusing a restart that bluetoothd started on its own, with no
 *   client's message waiting on it: start_discovery_complete() tries again
 *   after IDLE_DISCOV_TIMEOUT * 2 = 10 s, for as long as a client is still
 *   discovering. A failed first start answers its client InProgress and drops
 *   it instead.
 *
 * - clients with different filters: a client that set none (a regular
 *   discovery) merges with our LE filter into another kernel filter, so our
 *   leaving and rejoining restarts the kernel scan each time
 *   (update_discovery_filter()); `kernelStarts` counts those;
 * - a client's D-Bus connection going away (discovery_disconnect()), which
 *   runs discovery_stop() for it and answers or drops a message it left held;
 * - a room of advertisers: while the kernel scans for at least one
 *   discovering client, each one advertises once per `intervalMs` (default:
 *   on every look), and every advertisement moves its RSSI unless it is
 *   `constantRssi` (a filtered discovery reports every RSSI change, and only a
 *   change). discovery_cleanup() drops the temporary, non-connectable devices
 *   and clears the RSSI of the rest until they are heard again; a power-off
 *   drops every temporary device. A paired device is not temporary.
 * - ObjectManager.GetManagedObjects on the bus, which lists every Device1 with
 *   its Address and, only while BlueZ holds one, its RSSI. A device on a
 *   second adapter (hci1) whose RSSI moves on every read is always listed, so
 *   code that reads the wrong adapter's devices sees a busy room forever.
 *
 * Asynchronous steps (main-loop timeouts, mgmt replies) run on microtasks, so
 * they need no timers and work under fake timers. The one exception is that
 * 10 s retry, which runs on a timer: on a microtask, a kernel that stays busy
 * would retry forever without the clock moving.
 *
 * Not modelled: the kernel ending each LE discovery window by itself (about
 * 10.24 s) and bluetoothd restarting it from discovering_callback(). The model
 * scans until it is told to stop; `stallScan()` stands for that restart going
 * missing, which is the suspected way the Pi's scan went deaf mid-wait. Also
 * not modelled: RSSI/pathloss and UUID filters, BR/EDR inquiry,
 * suspend/resume.
 *
 * The D-Bus wire (`createBluetooth()`): the same model behind a fake system
 * bus socket, under the REAL node-ble and dbus-next. A test mocks only
 * node-ble's `createBluetooth()` to return it, so every Introspect, property
 * read, AddMatch and RemoveMatch our code causes is real dbus-next and node-ble
 * behaviour, and none of our module paths is mocked. What the wire adds:
 *
 * - the bus daemon: Hello, GetNameOwner, and AddMatch/RemoveMatch counted per
 *   connection and rule; a signal reaches a connection only through a rule it
 *   holds, and a connection that hangs up loses its rules and its discovery
 *   session (discovery_disconnect());
 * - the object tree as bluetoothd exports it (Adapter1, Device1, GattService1,
 *   GattCharacteristic1, AgentManager1, Properties, Introspectable), devices
 *   present while BlueZ holds them, GATT objects while services are resolved;
 * - Device1.Connect making the device permanent (dev_connect() ->
 *   btd_device_set_temporary(false)), Disconnect answered at once when the
 *   device is not connected, RemoveDevice;
 * - every advertisement of a device BlueZ already holds sent as a
 *   PropertiesChanged (RSSI, and ManufacturerData/ServiceData, which a
 *   DuplicateData filter reports on every report);
 * - notifications a scale sends in answer to a write (`Advertiser.respond`).
 *
 * BlueZ 5.82 by default: no Device1.Disconnected signal. `sendsDisconnectReason`
 * makes it 5.83: device_disconnected() declares and sends that signal with the
 * kernel's reason, before Connected goes false and before a Disconnect is
 * answered. Every answer comes on a microtask, notifications on timers.
 */

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

type Transport = 'le' | 'bredr' | 'auto';

/** What a client set with SetDiscoveryFilter. */
export interface ClientFilter {
  transport: Transport;
  duplicate: boolean;
}

/** The merged kernel filter (mgmt_cp_start_service_discovery), or null for a regular scan. */
type KernelFilter = { type: Transport } | null;

interface Pending {
  resolve: () => void;
  reject: (err: Error) => void;
}

interface Client {
  sender: string;
  filter: ClientFilter | null;
  /** In discovery_list, as opposed to only holding a pre-set filter. */
  discovering: boolean;
  /** An unanswered StartDiscovery or StopDiscovery (client->msg). */
  msg: Pending | null;
  /** Its D-Bus connection is still there (the client's disconnect watch). */
  watch: boolean;
}

const OK = 0;
const REJECTED = 0x0b;
const BUSY = 0x0a;

/** IDLE_DISCOV_TIMEOUT * 2: start_discovery_complete()'s retry of a failed restart. */
const RESTART_RETRY_MS = 10_000;

/** The adapter's own scan type: a dual-mode controller. */
const ADAPTER_SCAN_TYPE: Transport = 'auto';

export function bluezError(type: string, message: string): Error & { type: string } {
  return Object.assign(new Error(message), { type });
}

const busy = (): Error => bluezError('org.bluez.Error.InProgress', 'Operation already in progress');

/** How one device in the room advertises. */
export interface Advertiser {
  /** ADV_IND rather than ADV_NONCONN_IND: discovery_cleanup() keeps the device. */
  connectable?: boolean;
  /** Bonded, so not a temporary device: nothing but RemoveDevice drops it. */
  paired?: boolean;
  /** One advertisement per this many ms; 0 means one on every look. */
  intervalMs?: number;
  /** Always heard at the same RSSI, which BlueZ then never reports as a change. */
  constantRssi?: boolean;
  /** Device1.Name; none: a nameless device. */
  name?: string;
  manufacturerData?: { id: number; data: Buffer };
  /** UUID -> bytes. */
  serviceData?: Record<string, Buffer>;
  /** The GATT database BlueZ exports once services are resolved. */
  services?: FakeService[];
  /** What the scale notifies after a write of `data` to `charUuid`. */
  respond?: (charUuid: string, data: Buffer) => FakeNotification[];
  /** The connection ends this many ms after each Connect, for `dropReason`. */
  dropAfterConnectMs?: number;
  /** Why that connection ends; default `remote`, the scale hanging up. */
  dropReason?: DisconnectCause;
}

/** The kernel's reason for the end of a connection (MGMT_DEV_DISCONN_*). */
export type DisconnectCause = 'unknown' | 'timeout' | 'local' | 'remote' | 'auth' | 'suspend';

/** device_disconnected() in BlueZ 5.83 src/device.c: the signal's name and message. */
const DISCONNECT_REASONS: Record<DisconnectCause, [string, string]> = {
  unknown: ['org.bluez.Reason.Unknown', 'Unspecified'],
  timeout: ['org.bluez.Reason.Timeout', 'Connection timeout'],
  local: ['org.bluez.Reason.Local', 'Connection terminated by local host'],
  remote: ['org.bluez.Reason.Remote', 'Connection terminated by remote user'],
  auth: ['org.bluez.Reason.Authentication', 'Connection terminated due to authentication failure'],
  suspend: ['org.bluez.Reason.Suspend', 'Connection terminated by local host for suspend'],
};

export interface FakeService {
  uuid: string;
  chars: Array<{ uuid: string; flags: string[] }>;
}

export interface FakeNotification {
  afterMs: number;
  charUuid: string;
  data: Buffer;
}

const ADAPTER_PATH = '/org/bluez/hci0';
const OTHER_ADAPTER_DEVICE = '/org/bluez/hci1/dev_99_88_77_66_55_44';

const devicePath = (addr: string): string => `${ADAPTER_PATH}/dev_${addr.replace(/:/g, '_')}`;

/** What our code hands MessageBus.call(): a dbus-next Message's fields. */
interface RawMessage {
  destination?: string;
  path?: string;
  interface?: string;
  member?: string;
}

export class FakeBluez {
  powered = true;
  discovering = false;
  enable = 0;
  kernelScanning = false;
  currentFilter: KernelFilter = null;
  filteredDiscovery = false;
  discoveryType: Transport | 0 = 0;
  /** Every D-Bus call, as `sender method`, or `sender method -> stalled`. */
  readonly log: string[] = [];
  /** Every Powered value written over D-Bus, accepted or not. */
  readonly poweredWrites: boolean[] = [];
  /** Answer Powered writes with AccessDenied, as a strict D-Bus policy would. */
  refusePoweredWrites = false;
  /** Called on every Powered write before it takes effect. */
  onPoweredWrite: ((on: boolean) => void) | undefined;
  /** Called on every method call that BlueZ gets to, before it acts on it. */
  onCall: ((sender: string, method: string) => void) | undefined;
  /** Methods that get no answer at all on their next call, once each. */
  readonly stallNext = new Set<string>();
  /** Methods that fail with this error on every call, before BlueZ looks at them. */
  readonly failAlways = new Map<string, Error>();
  /**
   * Methods whose answer arrives this many ms late on their next call, once
   * each. BlueZ acts on the call right away; only the reply is held.
   */
  readonly delayNext = new Map<string, number>();
  /** Replies held back by `delayNext` that have not arrived yet. */
  answersPending = 0;
  /** Advertisers in range; `advertise()` adds one with a profile. */
  readonly room = new Set<string>();
  /** How often a client asked for the device list (Adapter1 children). */
  deviceListReads = 0;
  /** How often a client called ObjectManager.GetManagedObjects. */
  managedObjectsReads = 0;
  /** How often the kernel started a scan (a Start Discovery it accepted). */
  kernelStarts = 0;
  /** BlueZ 5.83 and later: Device1 declares and sends Disconnected (name, message). */
  sendsDisconnectReason = false;

  /** Device1 objects BlueZ holds, with the RSSI it holds (undefined: none). */
  private heard = new Map<string, number | undefined>();
  private profiles = new Map<string, Advertiser>();
  /** When each advertiser last advertised while BlueZ was listening. */
  private lastAdvertised = new Map<string, number>();
  /** The RSSI a `constantRssi` advertiser is always heard at. */
  private fixedRssi = new Map<string, number>();
  private rssiStep = 0;
  private otherAdapterRssi = -40;
  private clients = new Map<string, Client>();
  /** adapter->client: whose message a pending mgmt reply will answer. */
  private pendingOwner: Client | null = null;
  /** discovery_idle_timeout. */
  private idleTimer: { cancelled: boolean } | null = null;

  /** Every message our code sent over the wire, in order, and how BlueZ answered it. */
  readonly wire: WireEntry[] = [];
  /** Open wire connections by unique name. */
  private conns = new Map<string, WireConnection>();
  private connCount = 0;
  /** Devices a Connect made permanent: only RemoveDevice drops them. */
  private permanent = new Set<string>();
  /** Link state of every device that ever had one. */
  private links = new Map<string, DeviceLink>();

  /** The state the Pi was in: Discovering set, nobody's session, kernel idle. */
  enterPhantom(opts: { enable: 0 | 1; filter?: KernelFilter }): void {
    this.clients.clear();
    this.pendingOwner = null;
    this.discovering = true;
    this.enable = opts.enable;
    this.kernelScanning = false;
    this.currentFilter = opts.filter === undefined ? { type: 'le' } : opts.filter;
    this.filteredDiscovery = this.currentFilter !== null;
    this.discoveryType = opts.enable ? 'le' : 0;
  }

  /**
   * The kernel's scan ends and bluetoothd's restart of it goes missing, while
   * every client keeps its session and Discovering stays true: what the Pi
   * showed mid-wait on a session that was ours. `enable` is what bluetoothd is
   * left believing about the kernel.
   */
  stallScan(opts: { enable: 0 | 1 }): void {
    this.cancelIdleTimer();
    this.kernelScanning = false;
    this.enable = opts.enable;
  }

  isDiscoveringClient(sender: string): boolean {
    return this.clients.get(sender)?.discovering === true;
  }

  /** Advertisements reach the host and BlueZ reports them to `sender`. */
  delivering(sender: string): boolean {
    return this.kernelScanning && this.discovering && this.isDiscoveringClient(sender);
  }

  /** The bus connection of `sender` goes away (discovery_disconnect()). */
  disconnect(sender: string): void {
    const client = this.clients.get(sender);
    if (!client) return;
    client.watch = false;
    if (!client.discovering) {
      this.discoveryRemove(client);
      return;
    }
    this.discoveryStop(client);
  }

  /** Put a device in range that advertises the way `profile` says. */
  advertise(addr: string, profile: Advertiser = {}): void {
    this.profiles.set(addr, profile);
    this.room.add(addr);
  }

  /** BlueZ processes advertising reports only while it scans for a client. */
  private hearing(): boolean {
    return this.kernelScanning && this.discoveringClients().length > 0;
  }

  /** Every advertiser whose next advertisement is due is heard (device_found()). */
  private hearRoom(): void {
    if (!this.hearing()) return;
    const now = Date.now();
    for (const addr of this.room) {
      const profile = this.profiles.get(addr) ?? {};
      const last = this.lastAdvertised.get(addr);
      if (last !== undefined && now - last < (profile.intervalMs ?? 0)) continue;
      this.lastAdvertised.set(addr, now);
      const held = this.heard.has(addr);
      const prev = this.heard.get(addr);
      const rssi = this.rssiFor(addr, profile);
      this.heard.set(addr, rssi);
      if (held) this.reportAdvertisement(addr, profile, rssi !== prev);
    }
  }

  private rssiFor(addr: string, profile: Advertiser): number {
    if (profile.constantRssi) {
      if (!this.fixedRssi.has(addr)) this.fixedRssi.set(addr, this.nextRssi());
      return this.fixedRssi.get(addr)!;
    }
    const prev = this.heard.get(addr);
    let rssi = this.nextRssi();
    if (rssi === prev) rssi = this.nextRssi();
    return rssi;
  }

  private nextRssi(): number {
    this.rssiStep = (this.rssiStep + 1) % 30;
    return -50 - this.rssiStep;
  }

  private rssiOf(addr: string): number | undefined {
    this.hearRoom();
    return this.heard.get(addr);
  }

  /** ObjectManager.GetManagedObjects, reduced to what a client reads off Device1. */
  private managedObjects(): Record<string, Record<string, Record<string, { value: unknown }>>> {
    this.managedObjectsReads++;
    this.hearRoom();
    const objects: Record<string, Record<string, Record<string, { value: unknown }>>> = {
      '/org/bluez': { 'org.bluez.AgentManager1': {} },
      [ADAPTER_PATH]: { 'org.bluez.Adapter1': { Discovering: { value: this.discovering } } },
    };
    for (const [addr, rssi] of this.heard) {
      const props: Record<string, { value: unknown }> = { Address: { value: addr } };
      if (rssi !== undefined) props.RSSI = { value: rssi };
      objects[devicePath(addr)] = { 'org.bluez.Device1': props };
      // A GATT object under the device, which is no device itself.
      objects[`${devicePath(addr)}/service000a`] = {
        'org.bluez.GattService1': { UUID: { value: '0000181d-0000-1000-8000-00805f9b34fb' } },
      };
    }
    this.otherAdapterRssi = this.otherAdapterRssi === -40 ? -41 : -40;
    objects[OTHER_ADAPTER_DEVICE] = {
      'org.bluez.Device1': {
        Address: { value: '99:88:77:66:55:44' },
        RSSI: { value: this.otherAdapterRssi },
      },
    };
    return objects;
  }

  /** dbus-next's MessageBus.call() for the one raw call our code makes. */
  private rawCall(msg: RawMessage): Promise<{ body: unknown[] }> {
    if (
      msg.destination !== 'org.bluez' ||
      msg.path !== '/' ||
      msg.interface !== 'org.freedesktop.DBus.ObjectManager' ||
      msg.member !== 'GetManagedObjects'
    ) {
      return Promise.reject(
        bluezError('org.freedesktop.DBus.Error.UnknownMethod', String(msg.member)),
      );
    }
    if (this.stallNext.delete('GetManagedObjects')) return new Promise(() => {});
    return Promise.resolve({ body: [this.managedObjects()] });
  }

  /** node-ble's view of one D-Bus connection: `isDiscovering()` plus the BusHelper. */
  adapterFor(sender: string) {
    const device = (addr: string) => ({
      helper: {
        prop: async (name: string) => (name === 'RSSI' ? this.rssiOf(addr) : undefined),
      },
    });
    return {
      isDiscovering: async () => this.discovering,
      devices: async () => {
        this.deviceListReads++;
        this.hearRoom();
        return [...this.heard.keys()];
      },
      getDevice: async (addr: string) => {
        this.hearRoom();
        if (!this.heard.has(addr)) throw new Error('Device not found');
        return device(addr);
      },
      // node-ble's waitDevice: a getDevice() poll every 500 ms, never giving up.
      waitDevice: (addr: string) =>
        new Promise((resolve) => {
          const timer = setInterval(() => {
            this.hearRoom();
            if (this.heard.has(addr)) {
              clearInterval(timer);
              resolve(device(addr));
            }
          }, 500);
        }),
      helper: {
        object: ADAPTER_PATH,
        callMethod: (method: string, ...args: unknown[]) => this.call(sender, method, args),
        set: (name: string, value: { value: unknown }) => this.setProperty(name, value.value),
        dbus: { call: (msg: RawMessage) => this.rawCall(msg) },
      },
    };
  }

  call(sender: string, method: string, args: unknown[]): Promise<void> {
    return this.knobs(sender, method, () => this.dispatch(sender, method, args));
  }

  /** A method call as `stallNext`, `failAlways` and `delayNext` let it through. */
  private knobs<T>(sender: string, method: string, act: () => Promise<T>): Promise<T> {
    // A bluetoothd too busy to get to the call: nothing happens, nothing answers.
    if (this.stallNext.delete(method)) {
      this.log.push(`${sender} ${method} -> stalled`);
      return new Promise(() => {});
    }
    this.log.push(`${sender} ${method}`);
    this.onCall?.(sender, method);
    const failure = this.failAlways.get(method);
    if (failure) return Promise.reject(failure);
    const answer = act();
    const delay = this.delayNext.get(method);
    if (delay === undefined) return answer;
    this.delayNext.delete(method);
    this.answersPending++;
    const late = (): void => {
      this.answersPending--;
    };
    return new Promise<T>((resolve, reject) => {
      answer.then(
        (value) => setTimeout(() => (late(), resolve(value)), delay),
        (err: unknown) => setTimeout(() => (late(), reject(err)), delay),
      );
    });
  }

  /** The calls one sender made, method names only, in order. */
  methodsOf(sender: string): string[] {
    return this.log.filter((l) => l.startsWith(`${sender} `)).map((l) => l.split(' ')[1]);
  }

  private dispatch(sender: string, method: string, args: unknown[]): Promise<void> {
    switch (method) {
      case 'SetDiscoveryFilter':
        return this.setDiscoveryFilter(sender, parseFilter(args[0]));
      case 'StartDiscovery':
        return this.startDiscovery(sender);
      case 'StopDiscovery':
        return this.stopDiscovery(sender);
      default:
        return Promise.reject(bluezError('org.freedesktop.DBus.Error.UnknownMethod', method));
    }
  }

  async setProperty(name: string, value: unknown): Promise<void> {
    if (name !== 'Powered') throw bluezError('org.freedesktop.DBus.Error.InvalidArgs', name);
    const on = value === true;
    this.poweredWrites.push(on);
    this.onPoweredWrite?.(on);
    if (this.refusePoweredWrites) {
      throw bluezError('org.freedesktop.DBus.Error.AccessDenied', 'Rejected send message');
    }
    if (on === this.powered) return;
    if (on) {
      this.powered = true;
      return;
    }
    // hci_dev_close_sync(): a kernel that was scanning reports it stopped, one
    // that was not says nothing, so a stale discovery_enable survives.
    if (this.kernelScanning) {
      this.kernelScanning = false;
      this.discoveringEvent(0);
    }
    this.adapterStop();
    this.powered = false;
  }

  // --- D-Bus methods ---

  private setDiscoveryFilter(sender: string, filter: ClientFilter | null): Promise<void> {
    if (!this.powered) return Promise.reject(notReady());
    const client = this.clients.get(sender);
    if (client) {
      client.filter = filter;
      if (client.discovering) this.updateDiscoveryFilter();
      if (filter || client.discovering) return Promise.resolve();
      this.clients.delete(sender);
    } else if (filter) {
      this.clients.set(sender, { sender, filter, discovering: false, msg: null, watch: true });
    }
    return Promise.resolve();
  }

  private startDiscovery(sender: string): Promise<void> {
    if (!this.powered) return Promise.reject(notReady());
    let client = this.clients.get(sender);
    if (client?.discovering) return Promise.reject(busy());
    if (client) {
      if (client.msg) return Promise.reject(busy());
      client.discovering = true;
    } else {
      client = { sender, filter: null, discovering: true, msg: null, watch: true };
      this.clients.set(sender, client);
    }
    if (this.updateDiscoveryFilter() === OK) return Promise.resolve();
    return this.park(client);
  }

  private stopDiscovery(sender: string): Promise<void> {
    if (!this.powered) return Promise.reject(notReady());
    const client = this.clients.get(sender);
    if (!client?.discovering) {
      return Promise.reject(bluezError('org.bluez.Error.Failed', 'No discovery started'));
    }
    if (client.msg) return Promise.reject(busy());
    if (this.discoveryStop(client) === OK) return Promise.resolve();
    return this.park(client);
  }

  private park(client: Client): Promise<void> {
    this.pendingOwner = client;
    return new Promise<void>((resolve, reject) => {
      client.msg = { resolve, reject };
    });
  }

  // --- src/adapter.c ---

  private discoveringClients(): Client[] {
    return [...this.clients.values()].filter((c) => c.discovering);
  }

  /** merge_discovery_filters() + discovery_filter_to_mgmt_cp(). */
  private mergedFilter(): KernelFilter {
    let regular = false;
    const types = new Set<Transport>();
    for (const c of this.discoveringClients()) {
      const f = c.filter;
      if (!f || (f.transport === ADAPTER_SCAN_TYPE && !f.duplicate)) {
        regular = true;
        continue;
      }
      types.add(f.transport);
    }
    if (types.size === 0) return regular ? null : { type: ADAPTER_SCAN_TYPE };
    if (regular) return { type: ADAPTER_SCAN_TYPE };
    return { type: types.size === 1 ? [...types][0] : ADAPTER_SCAN_TYPE };
  }

  /** filters_equal(): no DuplicateData in a kernel filter. */
  private static filtersEqual(a: KernelFilter, b: KernelFilter): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.type === b.type;
  }

  /** Returns OK when nothing has to happen, or -EINPROGRESS (1) when a (re)start was queued. */
  private updateDiscoveryFilter(): number {
    const sd = this.mergedFilter();
    if (FakeBluez.filtersEqual(this.currentFilter, sd) && this.discovering) return OK;
    this.currentFilter = sd;
    this.triggerStartDiscovery();
    return 1;
  }

  private triggerStartDiscovery(delayMs = 0): void {
    this.cancelIdleTimer();
    if (!this.powered) return;
    const token = { cancelled: false };
    this.idleTimer = token;
    const fire = (): void => {
      if (!token.cancelled) this.startDiscoveryTimeout();
    };
    if (delayMs === 0) queueMicrotask(fire);
    else setTimeout(fire, delayMs);
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) this.idleTimer.cancelled = true;
    this.idleTimer = null;
  }

  private startDiscoveryTimeout(): void {
    this.idleTimer = null;
    const newType = ADAPTER_SCAN_TYPE;
    if (this.enable === 1) {
      if (!this.currentFilter && !this.filteredDiscovery && this.discoveryType === newType) {
        // Nobody's message is answered here either; it is what BlueZ does.
        this.discovering = true;
        return;
      }
      // Stop with no completion handler: "discovering_callback will take care
      // of that". A kernel that is not scanning rejects it and sends nothing.
      this.mgmtStopDiscovery(null);
      return;
    }
    this.mgmtStartDiscovery(this.currentFilter ? this.currentFilter.type : newType);
  }

  private startDiscoveryComplete(status: number, type: Transport): void {
    if (this.discoveringClients().length === 0) {
      if (status === OK) this.mgmtStopDiscovery(null);
      return;
    }
    if (status === OK) {
      this.discoveryType = type;
      this.enable = 1;
      this.filteredDiscovery = this.currentFilter !== null;
      this.discoveryComplete(OK);
      this.discovering = true;
      return;
    }
    // A first start that failed answers its client and drops it.
    const client = this.discoveryComplete(status);
    if (client) {
      this.discoveryRemove(client);
      return;
    }
    // A restart nobody is waiting on: bluetoothd tries it again later.
    this.triggerStartDiscovery(RESTART_RETRY_MS);
  }

  private discoveryStop(client: Client): number {
    if (this.discoveringClients().length > 1) {
      this.discoveryRemove(client);
      this.updateDiscoveryFilter();
      return OK;
    }
    if (this.enable === 0) {
      this.discoveryRemove(client);
      this.discovering = false;
      return OK;
    }
    this.pendingOwner = client;
    this.mgmtStopDiscovery((status) => this.stopDiscoveryComplete(status));
    return 1;
  }

  private stopDiscoveryComplete(status: number): void {
    const client = this.discoveryComplete(status);
    if (client) this.discoveryRemove(client);
    if (status !== OK) return;
    this.discoveryType = 0;
    this.enable = 0;
    this.filteredDiscovery = false;
    this.discovering = false;
  }

  /** Answers adapter->client's message: success, or busy (InProgress) on any failure. */
  private discoveryComplete(status: number): Client | null {
    const client = this.pendingOwner;
    if (!client) return null;
    this.pendingOwner = null;
    if (!client.msg) return client;
    const msg = client.msg;
    client.msg = null;
    if (status === OK) msg.resolve();
    else msg.reject(busy());
    return client;
  }

  private discoveryRemove(client: Client): void {
    client.discovering = false;
    if (this.pendingOwner === client) this.pendingOwner = null;
    // A client whose connection is still there and that set a filter stays
    // behind as a pre-set filter; anything else is freed, and an unanswered
    // message with it is simply dropped.
    if (!client.filter || !client.watch) this.clients.delete(client.sender);
    if (this.discoveringClients().length === 0) this.discoveryCleanup();
  }

  /** Drops the temporary, non-connectable devices and clears the RSSI of the rest. */
  private discoveryCleanup(): void {
    this.discoveryType = 0;
    this.cancelIdleTimer();
    for (const addr of [...this.heard.keys()]) {
      const profile = this.profiles.get(addr) ?? {};
      if (!profile.paired && !profile.connectable && !this.permanent.has(addr)) {
        this.heard.delete(addr);
      } else this.heard.set(addr, undefined);
    }
  }

  /** remove_temporary_devices(), on the way to a power-off. */
  private removeTemporaryDevices(): void {
    for (const addr of [...this.heard.keys()]) {
      if (!this.profiles.get(addr)?.paired && !this.permanent.has(addr)) this.heard.delete(addr);
    }
  }

  /** discovering_callback(), for MGMT_EV_DISCOVERING. */
  private discoveringEvent(on: 0 | 1): void {
    if (this.enable === on) return;
    this.enable = on;
    if (this.discoveringClients().length === 0) return;
    if (on === 0) this.triggerStartDiscovery();
    else this.cancelIdleTimer();
  }

  /** adapter_stop() on power-off. */
  private adapterStop(): void {
    const owner = this.pendingOwner;
    if (owner?.msg) {
      const msg = owner.msg;
      owner.msg = null;
      msg.reject(busy());
    }
    this.pendingOwner = null;
    this.clients.clear();
    for (const addr of this.links.keys()) this.dropLink(addr);
    this.removeTemporaryDevices();
    this.discoveryCleanup();
    this.filteredDiscovery = false;
    this.currentFilter = null;
    this.discovering = false;
  }

  // --- the kernel (net/bluetooth/mgmt.c) ---

  private mgmtStartDiscovery(type: Transport): void {
    queueMicrotask(() => {
      if (!this.powered) return this.startDiscoveryComplete(REJECTED, type);
      if (this.kernelScanning) return this.startDiscoveryComplete(BUSY, type);
      this.kernelScanning = true;
      this.kernelStarts++;
      this.startDiscoveryComplete(OK, type);
      this.discoveringEvent(1);
    });
  }

  private mgmtStopDiscovery(done: ((status: number) => void) | null): void {
    queueMicrotask(() => {
      if (!this.kernelScanning) {
        done?.(REJECTED);
        return;
      }
      this.kernelScanning = false;
      done?.(OK);
      this.discoveringEvent(0);
    });
  }

  // --- the D-Bus wire ---

  /**
   * node-ble's createBluetooth() over this model: the real dbus-next MessageBus
   * and node-ble Bluetooth on a fake socket. Every call is a new D-Bus
   * connection with a unique name of its own, as on the real bus.
   */
  createBluetooth(): { bluetooth: unknown; destroy: () => void } {
    const { MessageBus } = wireLib();
    const Bluetooth = nodeRequire('node-ble/src/Bluetooth.js') as new (bus: unknown) => unknown;
    const conn = new WireConnection(
      `:1.${++this.connCount}`,
      (c, msg) => this.receive(c, msg),
      (c) => this.hangUp(c),
    );
    this.conns.set(conn.name, conn);
    const bus = new MessageBus(conn) as { disconnect(): void };
    return { bluetooth: new Bluetooth(bus), destroy: () => bus.disconnect() };
  }

  /** Match rules still held on open connections, as `conn path Iface.member xN`. */
  heldMatches(): string[] {
    const out: string[] = [];
    for (const conn of this.conns.values()) {
      for (const [rule, n] of conn.matches) out.push(`${conn.name} ${shortRule(rule)} x${n}`);
    }
    return out.sort();
  }

  /** A line of the test's own in the wire log: a log line, a btmgmt call. */
  note(text: string): void {
    this.wire.push({ at: Date.now(), conn: '', call: text });
  }

  /** The wire log as text, times relative to `since`. */
  transcript(since: number): string[] {
    return this.wire.map(
      (e) =>
        `+${e.at - since}ms ${e.conn ? `${e.conn} ` : ''}${e.call}` +
        (e.answer ? ` -> ${e.answer}` : ''),
    );
  }

  private hangUp(conn: WireConnection): void {
    this.conns.delete(conn.name);
    this.disconnect(conn.name);
  }

  private receive(conn: WireConnection, msg: WireMessage): void {
    const entry: WireEntry = { at: Date.now(), conn: conn.name, call: describeCall(msg) };
    this.wire.push(entry);
    const fromBus = msg.destination === DBUS_NAME;
    const { Message } = wireLib();
    const answer = (fields: Record<string, unknown>): void =>
      conn.deliver(
        new Message({
          replySerial: msg.serial,
          sender: fromBus ? DBUS_NAME : BLUEZ_NAME,
          destination: conn.name,
          ...fields,
        }),
      );
    new Promise<Reply>((resolve) =>
      resolve(fromBus ? this.busMethod(conn, msg) : this.bluezMethod(conn, msg)),
    ).then(
      (reply) =>
        answer({ type: METHOD_RETURN, signature: reply?.signature ?? '', body: reply?.body ?? [] }),
      (err: unknown) => {
        const name = (err as { type?: string }).type ?? 'org.freedesktop.DBus.Error.Failed';
        entry.answer = name.replace(/^org\.(bluez|freedesktop\.DBus)\.Error\./, '');
        answer({ type: ERROR, errorName: name, signature: 's', body: [(err as Error).message] });
      },
    );
  }

  /** org.freedesktop.DBus, the daemon itself. */
  private busMethod(conn: WireConnection, msg: WireMessage): Reply {
    const arg = String(msg.body[0] ?? '');
    switch (msg.member) {
      case 'Hello':
        return { signature: 's', body: [conn.name] };
      case 'GetNameOwner':
        if (arg === BLUEZ_SERVICE) return { signature: 's', body: [BLUEZ_NAME] };
        throw bluezError(
          'org.freedesktop.DBus.Error.NameHasNoOwner',
          `Could not get owner of '${arg}'`,
        );
      case 'AddMatch':
        conn.matches.set(arg, (conn.matches.get(arg) ?? 0) + 1);
        return;
      case 'RemoveMatch': {
        const n = conn.matches.get(arg);
        if (!n) {
          throw bluezError(
            'org.freedesktop.DBus.Error.MatchRuleNotFound',
            "The given match rule wasn't found and can't be removed",
          );
        }
        if (n === 1) conn.matches.delete(arg);
        else conn.matches.set(arg, n - 1);
        return;
      }
    }
    throw bluezError('org.freedesktop.DBus.Error.UnknownMethod', String(msg.member));
  }

  /** org.bluez: bluetoothd's object tree. */
  private bluezMethod(conn: WireConnection, msg: WireMessage): Reply | Promise<Reply> {
    const path = msg.path ?? '';
    const iface = msg.interface ?? '';
    const member = msg.member ?? '';
    if (iface === INTROSPECTABLE) return { signature: 's', body: [this.introspect(path)] };
    if (path === '/' && iface === OBJECT_MANAGER && member === 'GetManagedObjects') {
      if (this.stallNext.delete('GetManagedObjects')) return new Promise(() => {});
      return { signature: 'a{oa{sa{sv}}}', body: [this.managedObjects()] };
    }
    const node = this.nodeAt(path);
    const missing = (): Error =>
      bluezError(
        node
          ? 'org.freedesktop.DBus.Error.UnknownMethod'
          : 'org.freedesktop.DBus.Error.UnknownObject',
        `Method "${member}" with signature "${msg.signature}" on interface "${iface}" doesn't exist`,
      );
    if (!node) throw missing();
    if (iface === PROPERTIES && node.iface !== undefined) {
      return this.properties(node, member, msg.body);
    }
    if (iface !== node.iface) throw missing();
    switch (node.kind) {
      case 'bluez':
        // RegisterAgent, RequestDefaultAgent, UnregisterAgent: always granted.
        return this.knobs(conn.name, member, async () => undefined);
      case 'adapter':
        if (member === 'RemoveDevice') {
          return this.knobs(conn.name, member, async () =>
            this.removeDeviceObject(String(msg.body[0])),
          );
        }
        return this.call(conn.name, member, msg.body);
      case 'device':
        return this.knobs(conn.name, member, async () => this.deviceMethod(node.addr, member));
      case 'char':
        return this.knobs(conn.name, member, async () => this.charMethod(node, member, msg.body));
    }
    throw missing();
  }

  private deviceMethod(addr: string, member: string): void {
    const link = this.linkOf(addr);
    const path = devicePath(addr);
    switch (member) {
      case 'Connect':
        if (link.connected)
          throw bluezError('org.bluez.Error.AlreadyConnected', 'Already Connected');
        this.permanent.add(addr);
        link.connected = true;
        link.connects++;
        this.emitProps(path, DEVICE1, { Connected: variant('b', true) });
        link.resolved = true;
        this.emitProps(path, DEVICE1, { ServicesResolved: variant('b', true) });
        this.scheduleDrop(addr, link);
        return;
      case 'Disconnect':
        // Answered at once when there is no connection (dev_disconnect()).
        this.dropLink(addr, 'local');
        return;
      case 'Pair':
        link.paired = true;
        this.emitProps(path, DEVICE1, { Paired: variant('b', true) });
        return;
      case 'CancelPairing':
        return;
    }
    throw bluezError('org.freedesktop.DBus.Error.UnknownMethod', member);
  }

  private charMethod(node: CharNode, member: string, body: unknown[]): Reply {
    const link = this.linkOf(node.addr);
    switch (member) {
      case 'StartNotify':
        link.notifying.add(node.uuid);
        this.emitProps(node.path, CHAR1, { Notifying: variant('b', true) });
        return;
      case 'StopNotify':
        link.notifying.delete(node.uuid);
        return;
      case 'ReadValue':
        return { signature: 'ay', body: [Buffer.alloc(0)] };
      case 'WriteValue': {
        const written = Buffer.from(body[0] as number[]);
        const frames = this.profiles.get(node.addr)?.respond?.(node.uuid, written) ?? [];
        for (const f of frames) {
          setTimeout(() => {
            if (!link.connected || !link.notifying.has(f.charUuid)) return;
            const target = this.gattNodes(node.addr).find(
              (n) => n.kind === 'char' && n.uuid === f.charUuid,
            );
            if (target) this.emitProps(target.path, CHAR1, { Value: variant('ay', f.data) });
          }, f.afterMs);
        }
        return;
      }
    }
    throw bluezError('org.freedesktop.DBus.Error.UnknownMethod', member);
  }

  /** Adapter1.RemoveDevice: the object goes, a connection to it first. */
  private removeDeviceObject(path: string): void {
    const addr = addressOf(path);
    if (addr === undefined || !this.heard.has(addr)) {
      throw bluezError('org.bluez.Error.DoesNotExist', 'Does Not Exist');
    }
    this.dropLink(addr, 'local');
    this.heard.delete(addr);
    this.permanent.delete(addr);
    this.links.delete(addr);
    this.lastAdvertised.delete(addr);
  }

  private linkOf(addr: string): DeviceLink {
    let link = this.links.get(addr);
    if (!link) {
      link = {
        connected: false,
        resolved: false,
        paired: this.profiles.get(addr)?.paired === true,
        trusted: false,
        notifying: new Set(),
        connects: 0,
      };
      this.links.set(addr, link);
    }
    return link;
  }

  /**
   * The connection ends for `cause`, in BlueZ 5.83's order: services
   * unresolved (queued by device_remove_connection() and flushed ahead of the
   * next signal), then Device1.Disconnected (device_disconnected()), then
   * Connected false. `local` by default, as a power-off ends it.
   */
  private dropLink(addr: string, cause: DisconnectCause = 'local'): void {
    const link = this.links.get(addr);
    if (!link?.connected) return;
    link.connected = false;
    link.resolved = false;
    link.notifying.clear();
    this.emitProps(devicePath(addr), DEVICE1, { ServicesResolved: variant('b', false) });
    if (this.sendsDisconnectReason) {
      this.emitSignal(devicePath(addr), DEVICE1, 'Disconnected', 'ss', DISCONNECT_REASONS[cause]);
    }
    this.emitProps(devicePath(addr), DEVICE1, { Connected: variant('b', false) });
  }

  /** `Advertiser.dropAfterConnectMs`: end this connection, not a later one, on a timer. */
  private scheduleDrop(addr: string, link: DeviceLink): void {
    const ms = this.profiles.get(addr)?.dropAfterConnectMs;
    if (ms === undefined) return;
    const connects = link.connects;
    setTimeout(() => {
      if (link.connects !== connects) return;
      this.dropLink(addr, this.profiles.get(addr)?.dropReason ?? 'remote');
    }, ms);
  }

  /** What one advertisement of a device BlueZ already holds reports (DuplicateData). */
  private reportAdvertisement(addr: string, profile: Advertiser, rssiMoved: boolean): void {
    if (this.conns.size === 0) return;
    const changed: Record<string, unknown> = {};
    const rssi = this.heard.get(addr);
    if (rssiMoved && rssi !== undefined) changed.RSSI = variant('n', rssi);
    Object.assign(changed, advertProps(profile));
    if (Object.keys(changed).length > 0) this.emitProps(devicePath(addr), DEVICE1, changed);
  }

  /** PropertiesChanged to every connection holding a rule that matches it. */
  private emitProps(path: string, iface: string, changed: Record<string, unknown>): void {
    this.emitSignal(path, PROPERTIES, 'PropertiesChanged', 'sa{sv}as', [iface, changed, []]);
  }

  /** A signal from bluetoothd to every connection holding a rule that matches it. */
  private emitSignal(
    path: string,
    iface: string,
    member: string,
    signature: string,
    body: unknown[],
  ): void {
    if (this.conns.size === 0) return;
    const { Message } = wireLib();
    const signal = new Message({
      type: SIGNAL,
      sender: BLUEZ_NAME,
      path,
      interface: iface,
      member,
      signature,
      body,
    });
    for (const conn of this.conns.values()) {
      if ([...conn.matches.keys()].some((r) => ruleMatches(r, path, iface, member))) {
        queueMicrotask(() => conn.deliver(signal));
      }
    }
  }

  private nodeAt(path: string): WireNode | undefined {
    if (path === '/' || path === '/org') return { kind: 'root', path };
    if (path === '/org/bluez') return { kind: 'bluez', path, iface: AGENT_MANAGER1 };
    if (path === ADAPTER_PATH) return { kind: 'adapter', path, iface: ADAPTER1 };
    const addr = addressOf(path);
    if (addr === undefined || !this.heard.has(addr)) return undefined;
    if (path === devicePath(addr)) return { kind: 'device', path, iface: DEVICE1, addr };
    return this.gattNodes(addr).find((n) => n.path === path);
  }

  /** The GATT objects of a device, while its services are resolved. */
  private gattNodes(addr: string): Array<ServiceNode | CharNode> {
    if (!this.links.get(addr)?.resolved) return [];
    const out: Array<ServiceNode | CharNode> = [];
    (this.profiles.get(addr)?.services ?? []).forEach((service, i) => {
      const handle = 0x10 * (i + 1);
      const svcPath = `${devicePath(addr)}/service${hex4(handle)}`;
      out.push({ kind: 'service', path: svcPath, iface: GATT_SERVICE1, addr, service });
      service.chars.forEach((c, j) => {
        out.push({
          kind: 'char',
          path: `${svcPath}/char${hex4(handle + 1 + 2 * j)}`,
          iface: CHAR1,
          addr,
          uuid: c.uuid,
          flags: c.flags,
        });
      });
    });
    return out;
  }

  private introspect(path: string): string {
    const node = this.nodeAt(path);
    let children: string[] = [];
    if (path === '/') children = ['org'];
    else if (path === '/org') children = ['bluez'];
    else if (node?.kind === 'bluez') children = ['hci0'];
    else if (node?.kind === 'adapter') {
      // Listing the adapter's children is how a client looks for devices.
      this.deviceListReads++;
      this.hearRoom();
      children = [...this.heard.keys()].map((a) => devicePath(a).slice(path.length + 1));
    } else if (node?.kind === 'device' || node?.kind === 'service') {
      const depth = path.split('/').length;
      children = this.gattNodes(node.addr)
        .filter((n) => n.path.startsWith(`${path}/`) && n.path.split('/').length === depth + 1)
        .map((n) => n.path.slice(path.length + 1));
    }
    const ifaces = !node?.iface
      ? []
      : [INTROSPECTABLE, node.iface, ...(node.kind === 'bluez' ? [] : [PROPERTIES])];
    const xmlOf = (i: string): string =>
      i === DEVICE1 && this.sendsDisconnectReason ? DEVICE1_583_XML : IFACE_XML[i];
    return (
      '<node>' +
      ifaces.map(xmlOf).join('') +
      children.map((c) => `<node name="${c}"/>`).join('') +
      '</node>'
    );
  }

  private properties(node: WireNode, member: string, body: unknown[]): Reply | Promise<Reply> {
    const props = this.propsOf(node);
    const [iface, name] = body as [string, string];
    if (iface !== node.iface) {
      throw bluezError('org.freedesktop.DBus.Error.InvalidArgs', `No such interface '${iface}'`);
    }
    if (member === 'GetAll') return { signature: 'a{sv}', body: [props] };
    if (!(name in props)) {
      throw bluezError('org.freedesktop.DBus.Error.InvalidArgs', `No such property '${name}'`);
    }
    if (member === 'Get') return { signature: 'v', body: [props[name]] };
    if (member !== 'Set') throw bluezError('org.freedesktop.DBus.Error.UnknownMethod', member);
    const value = valueOf(body[2]);
    if (node.kind === 'adapter' && name === 'Powered') return this.setProperty(name, value);
    if (node.kind === 'device' && name === 'Trusted') {
      this.linkOf(node.addr).trusted = value === true;
      return;
    }
    throw bluezError(
      'org.freedesktop.DBus.Error.PropertyReadOnly',
      `Property '${name}' is not writable`,
    );
  }

  private propsOf(node: WireNode): Record<string, unknown> {
    const v = variant;
    switch (node.kind) {
      case 'adapter':
        return {
          Address: v('s', 'DC:A6:32:00:11:22'),
          AddressType: v('s', 'public'),
          Name: v('s', 'pi'),
          Alias: v('s', 'pi'),
          Powered: v('b', this.powered),
          Discoverable: v('b', false),
          Pairable: v('b', true),
          Discovering: v('b', this.discovering),
        };
      case 'device': {
        // Reading a device is a look at the room, as for the RSSI before.
        this.hearRoom();
        const { addr } = node;
        const profile = this.profiles.get(addr) ?? {};
        const link = this.linkOf(addr);
        const props: Record<string, unknown> = {
          Address: v('s', addr),
          AddressType: v('s', 'public'),
          Alias: v('s', profile.name ?? addr.replace(/:/g, '-')),
          Paired: v('b', link.paired),
          Bonded: v('b', link.paired),
          Trusted: v('b', link.trusted),
          Blocked: v('b', false),
          Connected: v('b', link.connected),
          ServicesResolved: v('b', link.resolved),
          Adapter: v('o', ADAPTER_PATH),
          ...advertProps(profile),
        };
        if (profile.name !== undefined) props.Name = v('s', profile.name);
        const rssi = this.heard.get(addr);
        if (rssi !== undefined) props.RSSI = v('n', rssi);
        return props;
      }
      case 'service':
        return {
          UUID: v('s', node.service.uuid),
          Primary: v('b', true),
          Device: v('o', devicePath(node.addr)),
        };
      case 'char':
        return {
          UUID: v('s', node.uuid),
          Flags: v('as', node.flags),
          Notifying: v('b', this.linkOf(node.addr).notifying.has(node.uuid)),
        };
    }
    return {};
  }
}

// --- the D-Bus wire: module-level parts ---

const nodeRequire = createRequire(import.meta.url);

const DBUS_NAME = 'org.freedesktop.DBus';
const BLUEZ_SERVICE = 'org.bluez';
/** bluetoothd's unique name on the bus. */
const BLUEZ_NAME = ':1.0';
const INTROSPECTABLE = 'org.freedesktop.DBus.Introspectable';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const AGENT_MANAGER1 = 'org.bluez.AgentManager1';
const ADAPTER1 = 'org.bluez.Adapter1';
const DEVICE1 = 'org.bluez.Device1';
const GATT_SERVICE1 = 'org.bluez.GattService1';
const CHAR1 = 'org.bluez.GattCharacteristic1';

/** dbus-next MessageType. */
const METHOD_RETURN = 2;
const ERROR = 3;
const SIGNAL = 4;

/** What a dbus-next Message carries, as far as the wire reads it. */
interface WireMessage {
  serial: number | null;
  path?: string;
  interface?: string;
  member?: string;
  destination?: string;
  signature: string;
  body: unknown[];
}

type Reply = { signature: string; body: unknown[] } | void;

export interface WireEntry {
  at: number;
  /** The connection's unique name; empty for a note. */
  conn: string;
  call: string;
  /** The error BlueZ or the daemon answered with, short. */
  answer?: string;
}

interface DeviceLink {
  connected: boolean;
  resolved: boolean;
  paired: boolean;
  trusted: boolean;
  /** UUIDs of the characteristics with notifications on. */
  notifying: Set<string>;
  /** How many Connects this link has had: tells one connection from the next. */
  connects: number;
}

interface ServiceNode {
  kind: 'service';
  path: string;
  iface: string;
  addr: string;
  service: FakeService;
}

interface CharNode {
  kind: 'char';
  path: string;
  iface: string;
  addr: string;
  uuid: string;
  flags: string[];
}

type WireNode =
  | { kind: 'root'; path: string; iface?: undefined }
  | { kind: 'bluez'; path: string; iface: string }
  | { kind: 'adapter'; path: string; iface: string }
  | { kind: 'device'; path: string; iface: string; addr: string }
  | ServiceNode
  | CharNode;

interface WireLib {
  MessageBus: new (conn: unknown) => unknown;
  Message: new (fields: Record<string, unknown>) => unknown;
  Variant: new (signature: string, value: unknown) => unknown;
}

let wireLibCache: WireLib | undefined;

/** dbus-next, loaded only by a test that uses the wire. */
function wireLib(): WireLib {
  if (!wireLibCache) {
    const lib = nodeRequire('dbus-next') as Pick<WireLib, 'Message' | 'Variant'>;
    wireLibCache = {
      MessageBus: nodeRequire('dbus-next/lib/bus.js') as WireLib['MessageBus'],
      Message: lib.Message,
      Variant: lib.Variant,
    };
  }
  return wireLibCache;
}

const variant = (signature: string, value: unknown): unknown =>
  new (wireLib().Variant)(signature, value);

/** The socket a MessageBus writes to; the daemon's side is `receive`. */
class WireConnection extends EventEmitter {
  readonly stream = { writable: true, end: (): void => this.close() };
  /** Match rules this connection holds, with how often each was added. */
  readonly matches = new Map<string, number>();

  constructor(
    readonly name: string,
    private readonly onMessage: (conn: WireConnection, msg: WireMessage) => void,
    private readonly onHangUp: (conn: WireConnection) => void,
  ) {
    super();
  }

  /** dbus-next replaces this after `end`, as lib/connection.js does. */
  message = (msg: WireMessage): void => {
    if (!this.stream.writable) throw new Error('Cannot send message, stream is closed');
    queueMicrotask(() => this.onMessage(this, msg));
  };

  deliver(msg: unknown): void {
    if (this.stream.writable) this.emit('message', msg);
  }

  private close(): void {
    if (!this.stream.writable) return;
    this.stream.writable = false;
    queueMicrotask(() => {
      this.message = () => {
        this.emit('error', new Error('Tried to write a message to a closed stream'));
      };
      this.emit('end');
      this.onHangUp(this);
    });
  }
}

const IFACE_XML: Record<string, string> = (() => {
  const arg = (type: string, direction?: 'in' | 'out'): string =>
    `<arg type="${type}"${direction ? ` direction="${direction}"` : ''}/>`;
  const method = (name: string, ins: string[] = [], outs: string[] = []): string =>
    `<method name="${name}">${ins.map((t) => arg(t, 'in')).join('')}${outs.map((t) => arg(t, 'out')).join('')}</method>`;
  const iface = (name: string, members: string[]): string =>
    `<interface name="${name}">${members.join('')}</interface>`;
  return {
    [INTROSPECTABLE]: iface(INTROSPECTABLE, [method('Introspect', [], ['s'])]),
    [PROPERTIES]: iface(PROPERTIES, [
      method('Get', ['s', 's'], ['v']),
      method('Set', ['s', 's', 'v']),
      method('GetAll', ['s'], ['a{sv}']),
      `<signal name="PropertiesChanged">${arg('s')}${arg('a{sv}')}${arg('as')}</signal>`,
    ]),
    [AGENT_MANAGER1]: iface(AGENT_MANAGER1, [
      method('RegisterAgent', ['o', 's']),
      method('UnregisterAgent', ['o']),
      method('RequestDefaultAgent', ['o']),
    ]),
    [ADAPTER1]: iface(ADAPTER1, [
      method('StartDiscovery'),
      method('SetDiscoveryFilter', ['a{sv}']),
      method('StopDiscovery'),
      method('RemoveDevice', ['o']),
      method('GetDiscoveryFilters', [], ['as']),
    ]),
    [DEVICE1]: iface(DEVICE1, [
      method('Disconnect'),
      method('Connect'),
      method('ConnectProfile', ['s']),
      method('DisconnectProfile', ['s']),
      method('Pair'),
      method('CancelPairing'),
    ]),
    [GATT_SERVICE1]: iface(GATT_SERVICE1, []),
    [CHAR1]: iface(CHAR1, [
      method('ReadValue', ['a{sv}'], ['ay']),
      method('WriteValue', ['ay', 'a{sv}']),
      method('StartNotify'),
      method('StopNotify'),
    ]),
  };
})();

/** Device1 as BlueZ 5.83 and later declare it: with the Disconnected signal. */
const DEVICE1_583_XML = IFACE_XML[DEVICE1].replace(
  '</interface>',
  '<signal name="Disconnected"><arg type="s"/><arg type="s"/></signal></interface>',
);

/** ManufacturerData and ServiceData as Device1 holds them. */
function advertProps(profile: Advertiser): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (profile.manufacturerData) {
    const { id, data } = profile.manufacturerData;
    out.ManufacturerData = variant('a{qv}', { [id]: variant('ay', data) });
  }
  if (profile.serviceData) {
    const entries = Object.entries(profile.serviceData).map(([u, d]) => [u, variant('ay', d)]);
    out.ServiceData = variant('a{sv}', Object.fromEntries(entries));
  }
  return out;
}

/** The address of a device object or one under it. */
function addressOf(path: string): string | undefined {
  const m = /^\/org\/bluez\/hci0\/dev_([0-9A-F]{2}(?:_[0-9A-F]{2}){5})(?:\/|$)/.exec(path);
  return m ? m[1].replace(/_/g, ':') : undefined;
}

const hex4 = (n: number): string => n.toString(16).padStart(4, '0');

const valueOf = (v: unknown): unknown =>
  v !== null && typeof v === 'object' && 'value' in v ? (v as { value: unknown }).value : v;

const shortPath = (path: string): string =>
  path.startsWith('/org/bluez/') ? path.slice('/org/bluez/'.length) : path;

const shortIface = (iface: string): string => iface.slice(iface.lastIndexOf('.') + 1);

function ruleFields(rule: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of rule.matchAll(/(\w+)='?([^',]*)'?/g)) out[m[1]] = m[2];
  return out;
}

function ruleMatches(rule: string, path: string, iface: string, member: string): boolean {
  const f = ruleFields(rule);
  return (
    f.type === 'signal' &&
    (f.sender === undefined || f.sender === BLUEZ_SERVICE || f.sender === BLUEZ_NAME) &&
    (f.interface === undefined || f.interface === iface) &&
    (f.path === undefined || f.path === path) &&
    (f.member === undefined || f.member === member)
  );
}

function shortRule(rule: string): string {
  const f = ruleFields(rule);
  return `${shortPath(f.path ?? '*')} ${shortIface(f.interface ?? '*')}.${f.member ?? '*'}`;
}

/** One line per call, short enough to read a cycle in. */
function describeCall(msg: WireMessage): string {
  const path = shortPath(msg.path ?? '');
  const iface = shortIface(msg.interface ?? '');
  const [a0, a1, a2] = msg.body;
  switch (msg.member) {
    case 'AddMatch':
    case 'RemoveMatch':
      return `${msg.member} ${shortRule(String(a0))}`;
    case 'GetNameOwner':
      return `GetNameOwner ${String(a0)}`;
    case 'Introspect':
      return `Introspect ${path}`;
    case 'Get':
      return `Get ${path} ${shortIface(String(a0))}.${String(a1)}`;
    case 'GetAll':
      return `GetAll ${path} ${shortIface(String(a0))}`;
    case 'Set':
      return `Set ${path} ${shortIface(String(a0))}.${String(a1)}=${String(valueOf(a2))}`;
    case 'SetDiscoveryFilter': {
      const dict = (a0 ?? {}) as Record<string, unknown>;
      const filter = Object.entries(dict).map(([k, v]) => `${k}=${String(valueOf(v))}`);
      return `${iface}.SetDiscoveryFilter ${path} {${filter.join(',')}}`;
    }
    case 'RemoveDevice':
      return `${iface}.RemoveDevice ${path} ${shortPath(String(a0))}`;
    case 'WriteValue': {
      const type = valueOf((a1 as Record<string, unknown> | undefined)?.type);
      return `${iface}.WriteValue ${path} ${Buffer.from(a0 as number[]).toString('hex')} ${String(type)}`;
    }
    case 'RegisterAgent':
      return `${iface}.RegisterAgent ${path} ${String(a0)} ${String(a1)}`;
    case 'RequestDefaultAgent':
      return `${iface}.RequestDefaultAgent ${path} ${String(a0)}`;
    case 'Hello':
    case 'GetManagedObjects':
      return msg.member;
  }
  return `${iface}.${String(msg.member)} ${path}`;
}

function notReady(): Error {
  return bluezError('org.bluez.Error.NotReady', 'Resource Not Ready');
}

/** The dict our code sends, as Variants ({ value }), or an empty one. */
function parseFilter(arg: unknown): ClientFilter | null {
  const dict = (arg ?? {}) as Record<string, { value: unknown } | undefined>;
  const transport = dict.Transport?.value as Transport | undefined;
  const duplicate = dict.DuplicateData?.value === true;
  if (transport === undefined && !duplicate) return null;
  return { transport: transport ?? ADAPTER_SCAN_TYPE, duplicate };
}
