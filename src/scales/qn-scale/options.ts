import { z } from 'zod';

/**
 * The `ble.qn_*` config keys, owned here and placed into BleSchema by
 * src/config/schema.ts. The YAML keys stay flat and public: the HA add-on
 * writes them (D024, D076). configure() gets each one camelCased
 * (`qn_user_key` -> `qnUserKey`), see AdapterOptions.
 */
export const QN_BLE_OPTIONS = {
  /**
   * Protocol byte the QN handshake echoes back to the scale (#75, #331).
   *
   * The QN family disagrees about which value its firmware accepts, and the
   * wrong one is silent rather than an error: the scale acknowledges the whole
   * handshake and never streams a weight. The scale-info frame length picks a
   * default (0 for the 18-byte variant, the value the scale itself sent for
   * anything longer); set this when a scale runs the full handshake and then
   * reports nothing, or when its scale-info frame is unreliable in transit
   * (proxy transports) and sessions without it open on the wrong byte.
   */
  qn_protocol_byte: z.number().int().min(0).max(255).optional().nullable(),
  /**
   * Slot mask of the QN A00D user-delete frame `a0 0d 04 <mask> 00 ...`
   * (#461). Unset, the frame is not sent.
   *
   * The handshake used to answer the scale's 0x21 config request with this
   * frame on every QN scale (0xFE from openScale, 0xFC on the long dialects
   * from vendor-app captures), read as a "history response". In the vendor's
   * published SDK it is the command that deletes users from the scale, bit
   * i-1 selecting slot i, and the scales confirm it as a successful delete.
   * Set this only for a scale that stopped reporting once the frame was
   * dropped, knowing the slots the mask selects are deleted on every
   * connection (252 = slots 3 to 8, 254 = slots 2 to 8).
   */
  qn_report_byte: z.number().int().min(0).max(255).optional().nullable(),
  /**
   * Acknowledge every live QN weight frame with its own weight (#75, #235).
   *
   * One reading of a vendor-app capture has the app answering each 0x10 frame
   * with `a2 06 01 <that weight>`. The 20-byte extended dialect, the one that
   * capture covers, does it by default. It is not hardware confirmed, and the
   * 20-byte live frame, whose layout is not decoded yet, is never echoed.
   *
   * Set true on another dialect whose scale completes the whole handshake and
   * then streams nothing: it is the same class of silent failure as
   * `qn_protocol_byte`, and the same kind of knob. Left unset it changes
   * nothing; false turns the echo off on the extended dialect too.
   *
   * True also hands the scale the configured weight anchor: on the 20-byte
   * extended dialect in the ready-time A2, everywhere else as two A2 frames
   * right after START, the sequence two Android captures of the Arboleaf app
   * show (#331, #75). On the 19-byte dialect it also drops the ready-time A2
   * and sends the A00D #2 profile frame with the first user's age and
   * height, as that app does (#331, D033).
   */
  qn_weight_ack: z.boolean().optional().nullable(),
  /**
   * User key the QN profile frame carries, 1 to 9999 (#463).
   *
   * Per the vendor's published SDK the profile frame opens the session for a
   * user slot and carries the key the vendor app registered that user with,
   * and the scale keeps that key per slot. openScale's frame, the default
   * here, sends 8; the Feelfit, Arboleaf and GE apps send 1000. The Physiq
   * that refuses openScale's frame (`a1 06 02 01 00`) shows only the weight,
   * and no scale in the logs has streamed a live weight after a refusal.
   *
   * Set, the 18-, 19- and 20-byte dialects send the vendor-app profile frame
   * with this key, the first user's age, height and sex, and on the 18-byte
   * one the athlete setting, and skip openScale's ready-time A2. On the
   * 19-byte dialect that happens without `qn_weight_ack` too. On the 20-byte
   * one the START and the weight anchor wait for the scale's answer to the
   * profile frame, as the CS10G app sends them (#501), and the ready-time
   * anchor of `qn_weight_ack` is not sent. A wrong key leaves the scale
   * refusing the frame, as without the option. The classic dialect ignores
   * it. Left unset it changes nothing.
   */
  qn_user_key: z.number().int().min(1).max(9999).optional().nullable(),
  /**
   * User slot the QN profile frame, the weight anchor and the 0x22 stored-data
   * query are for, 1 to 8 (#501). Only with `qn_user_key`; without it this is
   * ignored with a warning.
   *
   * Per the vendor's published SDK the scale keeps up to 8 users, each in a
   * slot with the key the vendor app registered it with. ble-scale-sync sends
   * slot 1 unless this is set; the Arboleaf CS10G app of #501 registered its
   * user in slot 2, and the scale accepts key 1000 only for that slot. The
   * slot cannot be read from the scale: set the one the debug log names for
   * the scale's own results (`user slot N`). On the 18-, 19- and 20-byte
   * dialects; the first configured user's profile goes to that slot, nothing
   * is written to slot 1 then, and nothing for a user slot goes out before the
   * scale's 0x12 (#501). Left unset it changes nothing.
   */
  qn_user_slot: z.number().int().min(1).max(8).optional().nullable(),
  /**
   * Send the two 0xA4 0x0F frames an Arboleaf vendor app sends between START
   * and the first live 0x10 weight frame (#331).
   *
   * Replayed byte for byte from one reporter's HCI capture of their own unit.
   * The payload is NOT decoded: five uint16 pairs per frame, the same shape as
   * the 0xA2 weight anchor, so it may be per-user calibration. Off by default
   * for that reason, and worth trying only when the handshake is acknowledged
   * end to end and the scale then streams nothing.
   */
  qn_a4_prelude: z.boolean().optional().nullable(),
  /**
   * Send the 9-byte form of the QN 0x20 time-sync frame (#331).
   *
   * The Arboleaf vendor app sends `20 09 ff <secs LE> 08 <checksum>` where this
   * app sends `20 08 ff <secs LE> <checksum>`. The timestamp field, its
   * position and the family checksum rule are identical; the whole difference
   * is one extra byte before the checksum. Per the vendor's published SDK it
   * is the phone's UTC offset (`0x08` = UTC+2 in the captures), and the long
   * form sends the host's own offset there (`timeZoneByte`).
   *
   * Off by default and opt-in per install, for the same reason as
   * `qn_a4_prelude`: a frame the scale does not expect fails silently in
   * exactly the way `qn_protocol_byte` does, and every QN scale in the
   * registry reads today on the 8-byte form.
   */
  qn_time_sync_long: z.boolean().optional().nullable(),
  /**
   * Send the 10-byte form of the QN 0x13 config frame (#331).
   *
   * Two independent captures show the vendor app sending ten bytes where this
   * app sends nine:
   *
   *   app (#235 GE CS 10 G)   13 0a ff 01 10 00 00 02 00 2f
   *   hedoric capture (#235)  13 0a ff 01 10 00 00 00 fa 27
   *   ble-scale-sync          13 09 ff 01 10 00 00 00    2c
   *
   * Bytes [0..6] are identical and all three close under the family checksum,
   * so the whole difference is the pair at [7..8]. Its meaning is NOT decoded
   * and the two captures disagree on its value, so the app's own pair is
   * replayed rather than derived.
   *
   * Off by default and opt-in per install, for the same reason as
   * `qn_a4_prelude` and `qn_time_sync_long`: every QN scale in the registry
   * reads today on the 9-byte form, and a wrong value here fails silently.
   */
  qn_config_long: z.boolean().optional().nullable(),
  /**
   * Send the end-of-measurement frame `1f 05 <protocol type> 10 <sum>` after
   * the 0x16 of a complete result block on the 19-byte QN dialect (#331).
   *
   * The vendor's published SDK sends it there for every 8-electrode
   * weigh-in; this app has never sent it. Whether its absence is why the
   * scale stores a second copy of a weigh-in it already delivered, and keeps
   * advertising after the export, is not known, so this is opt-in and off by
   * default until reporters' logs with it show an effect and no harm. Other
   * QN dialects ignore it.
   */
  qn_result_ack: z.boolean().optional().nullable(),
};
