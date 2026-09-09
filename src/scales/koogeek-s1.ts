import type {
  BleDeviceInfo,
  ScaleAdapterCore,
  GattWiring,
  AckProtocol,
  HoldForComposition,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, biaFatIfPlausible, xorChecksum } from './body-comp-helpers.js';
import type { MatchDescriptor } from './match-descriptor.js';

const CHR_NOTIFY = uuid16(0xfff4);
const CHR_WRITE = uuid16(0xfff3);

/** Frame header shared by both directions. */
const MAGIC = [0x55, 0xaa, 0x55, 0xaa];

/** Inbound command bytes, read from data[4]. */
const CMD_INIT = 0x01;
const CMD_LIVE = 0x02;
const CMD_STABLE = 0x03;
const CMD_QUERY = 0x07;

/** Outbound reply command bytes. */
const CMD_ACK_INIT = 0x81;
const CMD_ACK_QUERY = 0x87;

const MIN_FRAME_LEN = 6; // magic(4) + command(1) + checksum(1)
const DATA_FRAME_LEN = 14;
const MAX_WEIGHT_KG = 300;

/** Wait this long for an impedance-bearing stable frame before settling for weight only. */
const COMPOSITION_HOLD_MS = 2000;

/**
 * Adapter for the Koogeek-S1 body-composition scale (issue #270).
 *
 * The protocol was reverse-engineered from the vendor's Smart Health app and
 * validated against real hardware by the reporter:
 *
 *   - Vendor service 0xFFF0, notify 0xFFF4, write 0xFFF3.
 *   - Frames are `55 AA 55 AA <cmd> [<0x01> outbound] <payload...> <XOR>`,
 *     where the trailing byte is the XOR of every preceding byte.
 *   - Once notifications are enabled the scale repeats a command 0x01 init
 *     frame and streams no weight at all until the client answers it with the
 *     command 0x81 acknowledgement. A command 0x07 query must be answered with
 *     command 0x87 echoing data[6]. Both replies are per-frame, so they live in
 *     buildAck and no onConnected handshake is needed.
 *   - Data frames are 14 bytes: command 0x02 is a live reading, 0x03 is the
 *     stable one. Weight is data[9..10] big endian tenths of a kg, impedance is
 *     data[11..12] big endian ohms.
 *
 * The vendor computed body composition in a cloud service that no longer
 * exists, so metrics come from the project's generic BIA path.
 *
 * Known limitation: this hardware's GATT connect and service discovery are
 * unreliable on BlueZ and on ESP32 NimBLE, and connect only occasionally on
 * macOS CoreBluetooth. That is a link-layer trait of the device, not something
 * an adapter can influence.
 */
export class KoogeekS1Adapter
  implements ScaleAdapterCore, GattWiring, AckProtocol, HoldForComposition
{
  readonly name = 'Koogeek-S1';
  readonly match: MatchDescriptor = {
    priority: 95,
    custom: true,
    names: { includes: ['koogeek-s1'] },
  };
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;
  readonly normalizesWeight = true;
  /**
   * 0xFFF3 is a vendor OEM command characteristic. Every other adapter in the
   * 0xFFF0 family writes without a response, so we do the same.
   *
   * This is inferred from the family rather than measured, and it only takes
   * effect on the native and ESPHome transports. The ESP32 MQTT proxy discards
   * the flag (see handler-mqtt-proxy/gatt.ts) and lets its firmware choose.
   */
  readonly ackWithResponse = false;

  /** True when the frame just parsed was the stable (command 0x03) reading. */
  private stable = false;

  /**
   * Matches on the advertised name only.
   *
   * A structural fallback keyed on the 0xFFF1 to 0xFFF6 characteristic set was
   * considered, so that the ESP32 proxy's autonomous connect path (which
   * resolves from characteristics alone, with no name and no services) could
   * identify a Koogeek. It was rejected. The Eufy P2 uses 0xFFF1, 0xFFF2 and
   * 0xFFF4 on the same 0xFFF0 service, and its own matcher returns false for a
   * nameless device, so priority could not protect it: if a Eufy's GATT table
   * happens to also expose the unused 0xFFF3, 0xFFF5 and 0xFFF6, a structural
   * Koogeek match would claim it and break a scale that works today (#251,
   * #258). Nothing in the project records whether it does.
   *
   * The cost is that a Koogeek cannot be auto-detected over the ESP32 proxy's
   * autonomous connect, which is no worse than before this adapter existed. The
   * native and ESPHome paths both preserve the advertised name.
   */
  matches(device: BleDeviceInfo): boolean {
    return (device.localName || '').toLowerCase().includes('koogeek-s1');
  }

  /**
   * A well-formed frame carries the magic header and a valid trailing XOR.
   * buildAck runs on every inbound frame, including frames from a device that
   * was matched by mistake, so this must be fully defensive.
   */
  private isValidFrame(data: Buffer): boolean {
    if (data.length < MIN_FRAME_LEN) return false;
    for (let i = 0; i < MAGIC.length; i++) {
      if (data[i] !== MAGIC[i]) return false;
    }
    return xorChecksum(data, 0, data.length - 1) === data[data.length - 1];
  }

  /** Assemble an outbound frame and append its XOR checksum. */
  private buildFrame(cmd: number, payload: number[]): number[] {
    const body = [...MAGIC, cmd, 0x01, ...payload];
    body.push(xorChecksum(body, 0, body.length));
    return body;
  }

  /**
   * The scale gates its weight stream on these replies:
   *   command 0x01 (init)  answered with 55 AA 55 AA 81 01 01 81
   *   command 0x07 (query) answered with 55 AA 55 AA 87 01 <data[6]> <XOR>
   * Data frames need no acknowledgement.
   */
  buildAck(data: Buffer): number[] | null {
    if (!this.isValidFrame(data)) return null;
    const cmd = data[4];
    if (cmd === CMD_INIT) return this.buildFrame(CMD_ACK_INIT, [0x01]);
    if (cmd === CMD_QUERY && data.length >= 7) return this.buildFrame(CMD_ACK_QUERY, [data[6]]);
    return null;
  }

  parseNotification(data: Buffer): ScaleReading | null {
    this.stable = false;
    if (!this.isValidFrame(data)) return null;

    const cmd = data[4];
    if (cmd !== CMD_LIVE && cmd !== CMD_STABLE) return null;
    if (data.length < DATA_FRAME_LEN) return null;

    const weight = ((data[9] << 8) | data[10]) / 10;
    if (!Number.isFinite(weight) || weight <= 0 || weight > MAX_WEIGHT_KG) return null;

    const impedance = (data[11] << 8) | data[12];
    this.stable = cmd === CMD_STABLE;
    return { weight, impedance };
  }

  /**
   * Only a stable frame finishes the read. Impedance is deliberately not
   * required: a stable frame measured through socks reports zero, and gating on
   * it would spin until the read timeout rather than record the weight.
   */
  isComplete(reading: ScaleReading): boolean {
    return this.stable && reading.weight > 0;
  }

  /** Prefer a stable frame carrying impedance, but never wait forever for one. */
  readonly completionHoldMs = COMPOSITION_HOLD_MS;

  isFinal(reading: ScaleReading): boolean {
    return reading.impedance > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // biaFatIfPlausible, not computeBiaFat: the latter bounds its output but
    // not its input, so an impedance outside 150-1200 ohm pins the 4 % floor or
    // the 60 % ceiling and publishes it as a confident number (#405). Rejected
    // means the Deurenberg estimate, which is what this adapter published
    // before the impedance was read at all.
    const fat = biaFatIfPlausible(reading.weight, reading.impedance, profile);
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }
}
