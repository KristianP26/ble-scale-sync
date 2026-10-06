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
 */

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
      this.heard.set(addr, this.rssiFor(addr, profile));
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
    // A bluetoothd too busy to get to the call: nothing happens, nothing answers.
    if (this.stallNext.delete(method)) {
      this.log.push(`${sender} ${method} -> stalled`);
      return new Promise(() => {});
    }
    this.log.push(`${sender} ${method}`);
    this.onCall?.(sender, method);
    const failure = this.failAlways.get(method);
    if (failure) return Promise.reject(failure);
    const answer = this.dispatch(sender, method, args);
    const delay = this.delayNext.get(method);
    if (delay === undefined) return answer;
    this.delayNext.delete(method);
    this.answersPending++;
    const late = (): void => {
      this.answersPending--;
    };
    return new Promise<void>((resolve, reject) => {
      answer.then(
        () => setTimeout(() => (late(), resolve()), delay),
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
      if (!profile.paired && !profile.connectable) this.heard.delete(addr);
      else this.heard.set(addr, undefined);
    }
  }

  /** remove_temporary_devices(), on the way to a power-off. */
  private removeTemporaryDevices(): void {
    for (const addr of [...this.heard.keys()]) {
      if (!this.profiles.get(addr)?.paired) this.heard.delete(addr);
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
