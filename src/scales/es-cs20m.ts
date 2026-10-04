import type {
  BleDeviceInfo,
  ScaleAdapterCore,
  GattWiring,
  Unlockable,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';

const CHR_NOTIFY = uuid16(0x2a10);
const CHR_WRITE = uuid16(0x2a11);

/**
 * Company id on the anonymous advertisement of the ESCS20MB2 hardware revision.
 *
 * The same 0x1A10 number the family uses for its GATT service, which is a
 * vendor habit rather than a coincidence, but the two live in different
 * namespaces and neither implies the other.
 */
const QINGNIU_COMPANY_ID = 0x1a10;

/** `00 04 00 31 | <6-byte MAC> | 01 09` on the unit captured for #376. */
const ANON_PAYLOAD_LEN = 12;
const ANON_MAC_OFFSET = 4;

/** The six address bytes, uppercase and colon-free, or null. */
function macBytes(address: string | undefined): string | null {
  if (!address) return null;
  const clean = address.replace(/[:-]/g, '').toUpperCase();
  return /^[0-9A-F]{12}$/.test(clean) ? clean : null;
}

/**
 * True when the advertisement carries the device's own address inside its
 * manufacturer data.
 *
 * This is the whole reason the anonymous unit can be claimed safely. It sends
 * no name and no service UUIDs (#376), so the only pre-connect signal is a
 * company id, and claiming every nameless device that advertises one company id
 * is precisely the shape that produced the wrong-adapter reports in #235, #318
 * and #320. An address echo is self-validating instead: a device that is not
 * this scale will not happen to contain the address it is transmitting from.
 * `lefu-signature.ts` claims its family the same way.
 *
 * Both byte orders are accepted. The #376 capture has it forward
 * (`cf ea 02 07 2c 87` from `CF:EA:02:07:2C:87`, which the reporter described
 * as reversed), and other vendors in this space reverse it, so requiring one
 * orientation would be a guess about firmware nobody has seen yet. Matching
 * either costs nothing: a random payload hitting the exact advertising address
 * in either direction is not a case worth designing around.
 */
function hasOwnMacEcho(device: BleDeviceInfo): boolean {
  const md = device.manufacturerData;
  if (!md || md.id !== QINGNIU_COMPANY_ID) return false;
  if (md.data.length !== ANON_PAYLOAD_LEN) return false;
  const own = macBytes(device.address);
  if (!own) return false;
  const embedded = md.data
    .subarray(ANON_MAC_OFFSET, ANON_MAC_OFFSET + 6)
    .toString('hex')
    .toUpperCase();
  const reversed = [...md.data.subarray(ANON_MAC_OFFSET, ANON_MAC_OFFSET + 6)]
    .reverse()
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return embedded === own || reversed === own;
}

/**
 * Adapter for the ES-CS20M BLE body-composition scale (Yunmai lineage).
 *
 * Also covers Renpho ES-32MD, which Renpho's own manual documents as the same
 * hardware family as ES-CS20M (same protocol, same characteristics). Some
 * ES-32MD units advertise with a `113360_` placeholder name instead of a model
 * string, so the matcher accepts that prefix too.
 *
 * Protocol details:
 *   - Service 0x1A10, notify 0x2A10, write 0x2A11
 *   - Start measurement command: [0x55, 0xAA, 0x90, ...]
 *   - Message ID 0x11 (power/status frame): byte[5]=0x01 on (also sent right
 *     after subscribe, before anyone steps on), byte[5]=0x00 off
 *   - Message ID 0x14 (weight frame): status at [5], weight at [8-9], optional
 *     resistance at [10-11]
 *   - Message ID 0x15 (STORED offline record, not a live "extended frame"):
 *     resistance at bytes [9-10]; the adapter still keeps that resistance,
 *     see the 0x15 branch below
 *   - Weight at [8-9] big-endian uint16 / 100 (kg)
 *   - Complete on a 0x14 final (status low nibble 1) or on the 0x11 power-off
 *
 * Per openScale PR #1300, some firmware variants do not flag a final 0x14
 * frame; the reading then completes on the 0x11 power-off frame. This adapter
 * supports both paths.
 */
export class EsCs20mAdapter implements ScaleAdapterCore, GattWiring, Unlockable {
  readonly name = 'ES-CS20M';
  readonly match: MatchDescriptor = {
    priority: 130,
    names: { includes: ['es-cs20m', 'es-32md'], startsWith: ['113360_'] },
    serviceUuids: ['1a10'],
  };
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;
  readonly normalizesWeight = true;
  readonly unlockCommand = [0x55, 0xaa, 0x90, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x94];
  readonly unlockIntervalMs = 0;

  private stable = false;
  private stopped = false;
  private resistance = 0;
  private lastWeight = 0;

  matches(device: BleDeviceInfo): boolean {
    // The ESCS20MB2 revision advertises anonymously: no name, no service UUIDs,
    // only manufacturer data. It is claimed on the address echo in that payload
    // rather than on the company id alone; see hasOwnMacEcho for why (#376).
    return matchesDescriptor(device, this.match) || hasOwnMacEcho(device);
  }

  /**
   * Parse an ES-CS20M notification frame.
   *
   * Three message types are handled:
   *
   * ID 0x11 - power/status frame:
   *   [5]      0x01 = on (also sent right after subscribe), 0x00 = off
   *            (measurement complete)
   *
   * ID 0x14 - weight frame:
   *   [5]      status: low nibble 0 = settling, 1 = final, anything else
   *            unclassified; bit 4 (0x10) = zero-current mode
   *   [8-9]    weight, big-endian uint16 / 100 (kg)
   *   [10-11]  resistance, big-endian uint16 (optional)
   *
   * ID 0x15 - stored offline record (an earlier weigh-in, not a live frame;
   * per renpho-escs20m protocol.py and a third-party capture of seven
   * records, payload [6:10] is the seconds since that weigh-in):
   *   [9-10]   resistance, big-endian uint16
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 2) return null;

    // Robust msgId: try data[2] first (with 55 AA header), fall back to data[0] (stripped)
    const msgId =
      data.length > 2 && (data[2] === 0x11 || data[2] === 0x14 || data[2] === 0x15)
        ? data[2]
        : data[0];

    // 0x11 - power/status frame
    if (msgId === 0x11) {
      if (data.length < 6) return null;
      if (data[5] === 0x01) {
        // Power on (also sent right after subscribe): reset state for a new weigh-in
        this.stable = false;
        this.stopped = false;
        this.resistance = 0;
        this.lastWeight = 0;
      } else if (data[5] === 0x00) {
        // Power off: measurement complete, return the last accumulated reading
        this.stopped = true;
        if (this.lastWeight > 0) {
          return { weight: this.lastWeight, impedance: this.resistance };
        }
      }
      return null;
    }

    if (msgId === 0x15) {
      // A stored offline record, which the original port read as an "extended
      // frame". Keeping its resistance attaches an earlier weigh-in's value to
      // the live weight; that change is tracked separately and deliberately
      // not made here.
      if (data.length >= 11) {
        this.resistance = data.readUInt16BE(9);
      }
      return null;
    }

    if (msgId !== 0x14) return null;
    if (data.length < 10) return null;

    // Low nibble is the phase (0 settling, 1 final, other values unclassified);
    // bit 4 is the zero-current mode the Renpho app stores on the scale, so
    // 0x10 is an ordinary settling frame and 0x11 an ordinary final. The unit
    // from #376 has been stuck in zero-current mode since 2026-09-06 and sends
    // every settling frame as 0x10, the first one at 10.60 kg on the way up
    // (renpho-escs20m#10). Taking any non-zero status as stable completed the
    // reading on that first frame. Status layout per renpho-escs20m
    // x55aa/protocol.py, confirmed by its R-A016 app capture.
    this.stable = (data[5] & 0x0f) === 0x01;
    const weight = data.readUInt16BE(8) / 100;

    // Range validation (0.5-300 kg) filters garbage during initial connection
    if (weight < 0.5 || weight > 300 || !Number.isFinite(weight)) return null;

    // Optional resistance in the weight frame
    if (data.length >= 12) {
      const r = data.readUInt16BE(10);
      if (r > 0) this.resistance = r;
    }

    this.lastWeight = weight;
    return { weight, impedance: this.resistance };
  }

  /**
   * Clear the previous weigh-in (#394).
   *
   * Adapters are shared singletons. These fields used to be cleared only inside
   * the 0x11 START branch, and no GATT capture of the anonymous ESCS20MB2
   * revision exists to show that frame is always sent (#376). Without a
   * session-start reset a stale `stopped` completes the
   * next session on an unsettled weight, a stale `lastWeight` replays the
   * previous reading verbatim on an orphan STOP, and a stale `resistance`
   * drives one person's BIA from another person's impedance.
   */
  onSessionStart(): void {
    this.stable = false;
    this.stopped = false;
    this.resistance = 0;
    this.lastWeight = 0;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && (this.stable || this.stopped);
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const comp: ScaleBodyComp = {};
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
