import type { MatchDescriptor, ScaleAdapter } from '../interfaces/scale-adapter.js';
import { StandardGattScaleAdapter } from './standard-gatt.js';
import { descriptorNameTokens } from './match-descriptor.js';

/**
 * Structural integrity checks for the scale-adapter registry.
 *
 * These run at startup and do NOT need BLE fixtures. Precedence itself is
 * decided by `resolveAdapter()` (resolve.ts): highest `match.priority` first,
 * array position only breaking ties (#245). These checks assert the
 * invariants around it:
 *
 *  - adapter names are unique (the name is used in logs and as the stable
 *    identifier in collision diagnostics);
 *  - the generic {@link StandardGattScaleAdapter} fallback is positioned last,
 *    so array order agrees with its priority 0 and it never shadows a
 *    specific adapter via its broad BCS/WSS match;
 *  - priorities are unique, so the priority order is total.
 *
 * The fixture-based collision guard (one representative {@link
 * '../interfaces/scale-adapter.js'.BleDeviceInfo} per adapter, resolved in
 * priority order, plus the post-discovery shapes that only collide once GATT
 * services and characteristics are known) lives in the test suite, since it
 * needs a fixture corpus that is test data, not shipped code.
 */
export interface RegistryCheckResult {
  errors: string[];
  warnings: string[];
}

/** Documented ordering invariants as priority comparisons: [higher-precedence, lower]. */
export const ORDERING_INVARIANTS: ReadonlyArray<readonly [string, string]> = [
  ['Senssun Fat Scale', 'QN Scale'],
  ['Eufy Smart Scale P2/P2 Pro', 'QN Scale'],
  // QN outranks Renpho on the shared "renpho" name. On a nameless device only
  // QN's hasSigConsent guard (qn-scale/matching.ts) keeps its fallback off the
  // A-R003, whose GATT services (inferred from its handles) include 0xFFE0 /
  // 0xFFF0, which it would otherwise claim ahead of Renpho (#507). Loosen that
  // guard and this order hands the A-R003 to QN.
  ['QN Scale', 'Renpho ES-WBE28'],
  ['Beurer BF720/BF105', 'Xiaomi Mi Scale 2'],
  // A CH100 exposes the SIG body composition service 0x181B, which Mi Scale 2
  // claims from any advertiser; the name claim alone does not order them (#503).
  ['Huawei CH100/AH100', 'Xiaomi Mi Scale 2'],
  ['Robi S9', 'MGB (Swan/Icomon/YG)'],
  // The FFB0 Lefu family resolves strictly Robi > Hutbit > MGB (#278). Robi
  // must outrank Hutbit so a named Robi carrying the OEM signature is never
  // stolen, and Hutbit must outrank MGB so a SWAN-branded Hutbit is not swept
  // up by MGB's bare-ffb0 descriptor claim. The overlap analysis below cannot
  // see this: it skips any pair where either side is custom.
  ['Robi S9', 'Hutbit'],
  ['Hutbit', 'MGB (Swan/Icomon/YG)'],
  // An AC 27 scale advertises the 0x27AC company id and FFB0, and both MGB
  // (bare FFB0) and Robi S9 (nameless FFB0 with FFB3) would otherwise claim
  // it, then send an init it ignores and parse none of its frames (#458,
  // #462, #466). Custom on both sides, so the overlap check below is silent.
  ['Active Era BS-06', 'MGB (Swan/Icomon/YG)'],
  ['Active Era BS-06', 'Robi S9'],
  // AAA0xx units (AAA002 and its siblings, #408) send the Silvergear 108
  // broadcast and advertise FFB0, so MGB's bare FFB0 claim would take them;
  // openScale loses them to its MGB handler exactly this way. Custom on both
  // sides, so the overlap check below is silent.
  ['Silvergear Smart Scale 108', 'MGB (Swan/Icomon/YG)'],
  // A P3 whose address began 0xFF, with 0x48 as the low byte of its company
  // id and 0xCF as the lowest byte of its clock, meets the P2 broadcast claim,
  // and the P2 adapter would read a plausible wrong weight from its clock and
  // status bytes. A P2 frame can never carry the address echo the C20 / P3
  // claim needs, so the order costs the P2 nothing (#408). Custom on both
  // sides, so the overlap check below is silent.
  ['Eufy Smart Scale C20/P3', 'Eufy Smart Scale P2/P2 Pro'],
  // The mqtt-proxy autonomous connect falls back to the highest-priority
  // adapter whose charNotifyUuid the device exposes. Both declare 0x2A9D, so
  // the A&D adapter above the ES-WBE28 would take every nameless WSS device
  // there, a change for other scales. Name claims that never overlap, so the
  // overlap check below cannot see it (#408).
  ['Renpho ES-WBE28', 'A&D UC-352BLE'],
  // The nameless A-R003 has 0xFFF2 and no 0xFFF4 next to its SIG stack, which
  // is what Inlife's characteristic rule claims. Renpho must stay above it, or
  // every transport that resolves after discovery hands the scale to Inlife
  // (#507). Custom on both sides, so the overlap check below is silent.
  ['Renpho ES-WBE28', 'Inlife'],
  // The IF_B2 claims on its exact name, but the mqtt-proxy notify-char
  // fallback takes the highest-priority adapter whose notify characteristic
  // the device has. Above Senssun Fat Scale it would take every unclassified
  // device with 0xFFF1, and one with 0xFFF1 and 0xFFF2 ahead of Eufy P2
  // (notify 0xFFF2); below it the fallback stays as it was.
  ['Senssun Fat Scale', 'Senssun IF_B2'],
];

/** Run structural checks over an adapter registry. Pure — no throw, no log. */
export function checkRegistryIntegrity(adapters: readonly ScaleAdapter[]): RegistryCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Duplicate names: the name is the stable handle used everywhere a collision
  // or selection is reported, so duplicates make diagnostics ambiguous.
  const seen = new Map<string, number>();
  adapters.forEach((a, i) => {
    const prev = seen.get(a.name);
    if (prev !== undefined) {
      errors.push(`Duplicate adapter name "${a.name}" at registry indices ${prev} and ${i}.`);
    } else {
      seen.set(a.name, i);
    }
  });

  // The generic GATT adapter matches by bare Body Composition / Weight Scale
  // service UUID and brand-name substrings, so it overlaps many specific
  // adapters by design. Its priority 0 (with the uniqueness check below) is
  // what sorts it under every specific adapter in resolveAdapter(); keeping it
  // last in the array as well keeps array order agreeing with that, so a
  // caller that still scans the array in order cannot be shadowed by it.
  const genericIdx = adapters.findIndex((a) => a instanceof StandardGattScaleAdapter);
  if (genericIdx === -1) {
    warnings.push(
      'No StandardGattScaleAdapter in registry — generic BCS/WSS scales will not be matched.',
    );
  } else if (genericIdx !== adapters.length - 1) {
    errors.push(
      `StandardGattScaleAdapter must be the last registry entry (it is a broad ` +
        `fallback); found at index ${genericIdx} of ${adapters.length - 1}. ` +
        `A specific adapter placed after it can be shadowed.`,
    );
  }

  // A deferred binding is one the handler leaves alone for the adapter to
  // enable in onConnected. Without onConnected nothing would ever enable it,
  // and the scale would connect and say nothing until the session timed out.
  // On anything but a notify binding the flag would mean nothing at all.
  for (const a of adapters) {
    for (const b of a.characteristics ?? []) {
      if (!b.deferred) continue;
      if (b.type !== 'notify') {
        errors.push(
          `Adapter "${a.name}" marks its ${b.type} binding ${b.uuid} deferred; only a notify ` +
            `binding can be deferred.`,
        );
      } else if (!a.onConnected) {
        errors.push(
          `Adapter "${a.name}" defers notify binding ${b.uuid} but has no onConnected to ` +
            `enable it.`,
        );
      }
    }
  }

  // Every registered adapter MUST declare a match descriptor (the member is
  // optional on the interface only so test mocks can omit it).
  for (const a of adapters) {
    if (!a.match) {
      errors.push(`Adapter "${a.name}" is missing a match descriptor (required in the registry).`);
    }
  }
  // Work only with adapters that declared a descriptor; the loop above already
  // recorded an error for any that did not.
  const withMatch = adapters.filter(
    (a): a is ScaleAdapter & { match: MatchDescriptor } => a.match !== undefined,
  );

  // Priorities must be a unique total order; the resolver relies on it.
  const prioritySeen = new Map<number, string>();
  for (const a of withMatch) {
    const prev = prioritySeen.get(a.match.priority);
    if (prev !== undefined) {
      errors.push(
        `Duplicate match.priority ${a.match.priority} on "${a.name}" and "${prev}". ` +
          `Priorities must be unique so selection is deterministic.`,
      );
    } else {
      prioritySeen.set(a.match.priority, a.name);
    }
  }

  // The generic adapter must be the unique lowest priority.
  if (withMatch.length > 0) {
    const minPriority = Math.min(...withMatch.map((a) => a.match.priority));
    const generic = withMatch.find((a) => a instanceof StandardGattScaleAdapter);
    if (generic && generic.match.priority !== minPriority) {
      errors.push(
        `StandardGattScaleAdapter must have the lowest match.priority; it has ` +
          `${generic.match.priority} but the minimum is ${minPriority}.`,
      );
    }
  }

  const byName = new Map(withMatch.map((a) => [a.name, a] as const));
  for (const [hi, lo] of ORDERING_INVARIANTS) {
    const a = byName.get(hi);
    const b = byName.get(lo);
    if (!a || !b) continue; // a renamed adapter fails registry-check.test.ts
    if (a.match.priority <= b.match.priority) {
      errors.push(
        `Ordering invariant violated: "${hi}" (priority ${a.match.priority}) must ` +
          `outrank "${lo}" (priority ${b.match.priority}).`,
      );
    }
  }

  // Overlap detection: two NON-custom adapters that claim the same name token,
  // service UUID or MiBeacon product id would shadow each other on descriptor
  // data alone, with no bespoke disambiguator. That is an error. Overlaps where
  // at least one side is `custom` (its matches() applies extra
  // char/byte/exclusion logic) are expected and intentionally NOT flagged; they
  // are covered by the fixture-based registry-collision test. The generic
  // adapter overlaps many by design and is skipped.
  for (let i = 0; i < withMatch.length; i++) {
    for (let j = i + 1; j < withMatch.length; j++) {
      const a = withMatch[i];
      const b = withMatch[j];
      if (a instanceof StandardGattScaleAdapter || b instanceof StandardGattScaleAdapter) continue;
      if (a.match.custom || b.match.custom) continue;
      const aNames = new Set(descriptorNameTokens(a.match));
      const sharedName = descriptorNameTokens(b.match).some((t) => aNames.has(t));
      const aSvc = new Set((a.match.serviceUuids ?? []).map((u) => u.toLowerCase()));
      const sharedSvc = (b.match.serviceUuids ?? []).some((u) => aSvc.has(u.toLowerCase()));
      const aPid = new Set(a.match.miBeaconProductIds ?? []);
      const sharedPid = (b.match.miBeaconProductIds ?? []).some((p) => aPid.has(p));
      if (!sharedName && !sharedSvc && !sharedPid) continue;
      errors.push(
        `Adapters "${a.name}" and "${b.name}" claim the same name/service/product id with ` +
          `no custom disambiguator. One will shadow the other.`,
      );
    }
  }

  return { errors, warnings };
}

/**
 * Assert the registry is structurally sound. Throws on `errors` so a bad
 * registry fails fast at process start (and in CI) rather than silently
 * mis-routing a scale in the field. `warnings` are returned for the caller
 * to log.
 */
export function assertRegistryIntegrity(adapters: readonly ScaleAdapter[]): string[] {
  const { errors, warnings } = checkRegistryIntegrity(adapters);
  if (errors.length > 0) {
    throw new Error(`Scale adapter registry integrity check failed:\n  - ${errors.join('\n  - ')}`);
  }
  return warnings;
}
