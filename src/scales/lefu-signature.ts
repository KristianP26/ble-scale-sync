import type { BleDeviceInfo } from '../interfaces/scale-adapter.js';
import { uuidClaimHits } from './match-descriptor.js';

/**
 * Shared advertisement fingerprint for Lefu OEM stock units sold as the Hutbit
 * 218008 / WL292 (#254, #278).
 *
 * This lives in its own module rather than in `hutbit.ts` because both the
 * Hutbit adapter (to claim the unit) and the Robi S9 adapter (to bow out of it)
 * need the exact same predicate, and adapters do not import each other. The
 * established alternatives were both worse: inlining the constant twice
 * (as `mi-scale-2.ts` does with Beurer's company id) lets the two copies drift
 * apart, and drift here is a live-device false-match rather than a cosmetic bug.
 *
 * Both callers MUST use this one predicate. An asymmetric pair, where Robi bows
 * out of a wider set than the Hutbit claims, would strand a device between the
 * two: rejected by Robi, unclaimed by Hutbit, and swept up by MGB on the bare
 * FFB0 service, whose parser rejects every frame this family sends.
 */

/**
 * Company id in the advertisement's manufacturer data.
 *
 * SIG-assigned to RTB Elektronik GmbH & Co. KG, not to Lefu. The Lefu firmware
 * squats on it, which is exactly why this is a weak family marker rather than a
 * model fingerprint, and why it is only ever used gated behind the advertised
 * service UUIDs below (compare `match-descriptor.ts`, which documents
 * `manufacturerId` as "a weak signal on its own").
 */
const LEFU_COMPANY_ID = 0x02ac;

/** Vendor GATT service every FFB0-family Lefu unit advertises. */
const SVC_FFB0 = 'ffb0';

/**
 * Second service in the same advertising data element as FFB0 on the unit
 * captured for #278. Almost certainly a generic Lefu OEM service rather than a
 * Hutbit marker, so it narrows this claim against unrelated devices squatting
 * on RTB Elektronik's company id, and it does NOT discriminate the Hutbit from
 * a Robi S9 or an MGB.
 *
 * It is NOT universal within the family. A Juniper-branded unit running the
 * same Lefu AC02 protocol advertises FFB0 alone (#322):
 *
 *   Advert: name="SWAN" uuids=[ffb0] manufacturerData={0x02ac: c3b4d5ecb60100}
 *
 * That unit's payload is its own MAC reversed plus the 0x00 status byte, and
 * its traffic is genuine AC02 (stable `ac 02 04 06 00 00 ca d4` = 103.0 kg,
 * then `ac 02 fd 01 02 09 cb d4` = 521 ohm, both checksum-valid). Requiring
 * D618 sent it to the MGB adapter, whose parser rejects every frame it sends,
 * so the session ended in a GATT reading timeout every cycle.
 *
 * It is still required for NAMELESS advertisements. See `isHutbitOemAdvert`.
 */
const SVC_D618 = 'd618';

/**
 * True when the advertisement carries the Lefu OEM stock fingerprint of a
 * Hutbit 218008: manufacturer data under company id 0x02AC whose payload is the
 * device's own MAC reversed, optionally followed by a status byte
 * (0x00 idle / 0x01 active), advertised alongside both the FFB0 and D618
 * services.
 *
 * Two payload shapes are attested by hardware:
 *
 *   7 bytes  `7EB893ECB303|01`  MAC 03:B3:EC:93:B8:7E, nRF capture in #278
 *   6 bytes  `12A291ECB303`     MAC 03:B3:EC:91:A2:12, debug log in #318
 *
 * The 6-byte form omits the status byte entirely. Requiring 7 was what sent
 * #318's unit to the MGB adapter, whose parser rejects every AC02 frame this
 * family sends, so the length check accepts both and the status byte is only
 * validated when it is present.
 *
 * Only the shape is checked, not the MAC itself: `BleDeviceInfo` carries no
 * address field, and a MAC check would not disambiguate anyway, since every
 * device in this family reverses its own MAC.
 *
 * Why an advertisement fingerprint at all: the branded unit advertises
 * "Hutbit Scale", but Lefu OEM stock advertises "SWAN", and over the ESPHome
 * proxy the local name arrives empty because it lives in the scan response.
 * The manufacturer data and service list ride in the advertisement proper, so
 * they survive every transport that populates `manufacturerData`.
 *
 * D618 is required only when the advertisement carries NO local name, and the
 * asymmetry is deliberate. The nameless FFB0 space belongs to the Robi S9,
 * which claims it on FFB0 plus its FFB3 result characteristic at a higher
 * priority, and a Robi reaching a proxy transport arrives nameless by
 * construction. Dropping D618 there would hand those units to this adapter,
 * which subscribes FFB1/FFB2 only and rejects every 20-byte Robi frame on
 * length (#248 runs on exactly that transport).
 *
 * What the named case takes, stated exactly, because the tempting summary
 * ("a named device has already been claimed by its own adapter") is FALSE:
 *
 *   `RobiS9Adapter.matches()` claims only a name containing `robi` and bows
 *   out of only `swan`, `icomon` and `yg`. Every OTHER name falls through to
 *   this predicate. So a Robi sold under a rebadged name, and an MGB
 *   Icomon/YG/Swan, are both claimed here at priority 35 if they carry the
 *   0x02AC signature. Observed against the live registry:
 *
 *     named "Robi S9",  ffb0 + ffb3 chars, 0x02AC  ->  Robi S9   (unchanged)
 *     named "S9",       ffb0 + ffb3 chars, 0x02AC  ->  Hutbit
 *     named "icomon",   ffb0,              0x02AC  ->  Hutbit    (was MGB)
 *
 * No captured Robi or MGB advertisement in this repo carries 0x02AC
 * manufacturer data, so this is a family-shaped risk rather than an observed
 * one, and the failure mode is a refused read rather than a wrong weight,
 * since each parser rejects the other's frames on length. But this is a Lefu
 * OEM family where the branded name is known NOT to be universal (the Hutbit's
 * own OEM stock advertises "SWAN"), so it is a real exposure and not a
 * theoretical one. `ble.force_scale_adapter` with `ble.scale_mac` is the
 * escape hatch if a unit turns up on the wrong side of it.
 *
 * The FFB3 result characteristic is NOT usable as a negative gate here: the
 * Hutbit exposes an unused FFB3 too, so gating on it would hand a nameless
 * Hutbit straight back to Robi, which is the exact regression this predicate
 * exists to prevent (#278).
 */
export function isHutbitOemAdvert(device: BleDeviceInfo): boolean {
  const m = device.manufacturerData;
  if (m?.id !== LEFU_COMPANY_ID) return false;
  if (m.data.length !== 6 && m.data.length !== 7) return false;
  if (m.data.length === 7 && m.data[6] !== 0x00 && m.data[6] !== 0x01) return false;
  if (!uuidClaimHits([SVC_FFB0], device.serviceUuids)) return false;
  if (device.localName) return true;
  return uuidClaimHits([SVC_D618], device.serviceUuids);
}

export { LEFU_COMPANY_ID };
