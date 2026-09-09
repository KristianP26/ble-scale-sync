/**
 * Pure frame builders for the QN family.
 *
 * Every one of these is byte-pinned by tests against a real capture, so they
 * are the safest thing in the adapter to change and the most dangerous thing to
 * "consolidate". See the note on buildA2Frame in particular.
 */

/**
 * Build the extended-dialect measurement trigger for a weight anchor in kg.
 *
 * Clamped to the u16 the field can hold, so a nonsense config value degrades to
 * a wrong anchor rather than a malformed frame.
 */
export function buildMeasurementTrigger(weightKg: number): number[] {
  return buildA2Frame(Math.round(weightKg * 100));
}

/**
 * Build an A2 frame around a raw u16 payload.
 *
 * Separate from `buildMeasurementTrigger` because the live acknowledgement
 * echoes the scale's OWN raw weight bytes back verbatim, which is independent
 * of `weightScaleFactor`; only the pre-stream anchor has to convert from kg.
 */
// DO NOT merge this with the ready-time A2 the handshake builds inline. That
// frame is `a2 06 01 32 <age>`, the identical shape, and buildA2Frame((0x32 <<
// 8) | age) would emit the same bytes for every age the clamp accepts. They are
// deliberately different frames whose payloads the scale reads differently, and
// the comment on TRIGGER_WEIGHT_FALLBACK_KG in constants.ts says why.
export function buildA2Frame(raw: number): number[] {
  const v = Math.min(0xffff, Math.max(0, Math.round(raw)));
  const cmd = [0xa2, 0x06, 0x01, (v >> 8) & 0xff, v & 0xff, 0x00];
  cmd[5] = cmd.slice(0, 5).reduce((a, b) => a + b, 0) & 0xff;
  return cmd;
}

/**
 * The extra byte the vendor app's 0x20 time sync carries and ours does not.
 *
 * From the Arboleaf CS10E HCI capture in #331, next to the reporter's own log
 * of this app in the same session:
 *
 *   vendor app       20 09 ff f3 b3 22 32 08 2a     9 bytes
 *   ble-scale-sync   20 08 ff a1 aa 22 32 c6        8 bytes
 *
 * Both close under the family's sum-of-preceding-bytes checksum (0x2a and 0xc6),
 * `[1]` is the total frame length in both, and `[3..6]` little-endian is seconds
 * since 2000-01-01 in both, 2386 s apart on the capture day. So the timestamp
 * field, its position and the checksum rule are identical and the entire
 * difference is this one byte before the checksum.
 *
 * WHAT IT MEANS IS NOT DECODED. That is why `ble.qn_time_sync_long` is off by
 * default: a wrong value here is silent in exactly the way `qn_protocol_byte`
 * is, and every QN scale in the registry reads today on the 8-byte form.
 *
 * The app's 0x13 config frame is likewise one byte longer than ours. That one
 * lives in `buildConfig` below, behind its own switch for the same reason: two
 * frames moving at once makes a reporter's result unreadable.
 */
const TIME_SYNC_TRAILER = 0x08;

/**
 * 0x13 config frame trailer, the two bytes the vendor app has where this app
 * has one.
 *
 * Two independent captures of the 10-byte form, against our 9-byte one:
 *
 *   app (#235 GE CS 10 G)   13 0a ff 01 10 00 00 02 00 2f
 *   hedoric capture (#235)  13 0a ff 01 10 00 00 00 fa 27
 *   ble-scale-sync          13 09 ff 01 10 00 00 00    2c
 *
 * All three close under the family's sum-of-preceding-bytes checksum (0x2f,
 * 0x27, 0x2c), which is what makes the transcription trustworthy rather than a
 * miscount. `[1]` is the total frame length in all three, and bytes `[0..6]`
 * are identical, so the entire difference is the pair at `[7..8]`.
 *
 * WHAT THOSE TWO BYTES MEAN IS NOT DECODED, and the captures disagree on their
 * value (`02 00` vs `00 fa`), which rules out a constant. The app's own pair is
 * replayed here because it is the only one paired with a session that went on
 * to stream weight. Opt-in and off by default for the same reason as
 * `qn_a4_prelude`: every QN scale in the registry reads today on the 9-byte
 * form, and a wrong value here fails silently.
 */
const CONFIG_TRAILER = [0x02, 0x00] as const;

/** The single byte at `[7]` the 9-byte form has where the 10-byte form has two. */
const CONFIG_TAIL_SHORT = [0x00] as const;

/**
 * Build the 0x13 config frame.
 *
 * `unitFlag` is 0x01 kg / 0x02 lb per openScale QNHandler; honouring the
 * configured unit is what keeps a read from flipping the scale's display
 * (#269).
 *
 * Exported so a test can pin both forms against the captured frames byte for
 * byte, the way `buildTimeSync` is.
 */
export function buildConfig(protocolType: number, unitFlag: number, long = false): number[] {
  const body = [
    0x13,
    long ? 0x0a : 0x09,
    protocolType,
    unitFlag,
    0x10,
    0x00,
    0x00,
    ...(long ? CONFIG_TRAILER : CONFIG_TAIL_SHORT),
  ];
  return [...body, body.reduce((a, b) => a + b, 0) & 0xff];
}

/**
 * Build the 0x20 time-sync frame.
 *
 * Exported so a test can pin it against the captured frame byte for byte
 * without having to control the handshake's wall clock.
 */
export function buildTimeSync(protocolType: number, seconds: number, long = false): number[] {
  const s = seconds >>> 0;
  const body = [
    0x20,
    long ? 0x09 : 0x08,
    protocolType,
    s & 0xff,
    (s >> 8) & 0xff,
    (s >> 16) & 0xff,
    (s >>> 24) & 0xff,
  ];
  if (long) body.push(TIME_SYNC_TRAILER);
  return [...body, body.reduce((a, b) => a + b, 0) & 0xff];
}
