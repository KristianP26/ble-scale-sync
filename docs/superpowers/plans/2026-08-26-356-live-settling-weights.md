# #356 Publish settling weights as live data for broadcast scales

## The hard constraint
"A provisional value must be structurally incapable of reaching an exporter."
Structurally, not by convention. So it must NOT be a `ScaleReading`.

`ScaleReading.impedance` is REQUIRED. A type with only `weight` is therefore not
assignable to `ScaleReading`, and every exporter path takes `ScaleReading` or
`RawReading`. That is the barrier, enforced by the type checker rather than by
a reviewer noticing.

## Design

1. `LiveWeight { weight: number }` in `interfaces/scale-adapter.ts`. No
   impedance, no timestamp, on purpose.
2. `BroadcastSource.parseLiveBroadcast?(manufacturerData): LiveWeight | null`.
   Contract: called only for frames `parseBroadcast` returned null for, and it
   must never return a value for a frame `parseBroadcast` would accept, so one
   frame can never be reported twice.
3. `evaluateAdvertisement` is the single unified decision point for every
   transport (#242). The `wait` decision gains an optional `live`: "no reading
   yet, and here is what the scale is showing while you wait." No new decision
   kind, so no caller is forced to change, and the value rides on the decision
   that already means not-a-reading.
4. `onLiveWeight?: (live: LiveWeight) => void` alongside the existing
   `onLiveData` seam, threaded to the `wait` branches.
5. Silvergear implements it: the settling stream it currently logs and drops.
   Same plausibility bound as a settled frame, so a garbled frame cannot render
   6553 kg on somebody's display.
6. Consumer: the live status line, which already renders `onLiveData`.

## Explicitly NOT done
- No exporter consumes it. That is the point of the issue.
- No change to `isComplete`, and no adapter reports a provisional value from
  `parseBroadcast`.

## Tests that must exist
- `LiveWeight` cannot satisfy `ScaleReading` (compile-level, asserted in a type
  test with @ts-expect-error).
- A settling frame yields a live weight and NOT a reading.
- A settled frame yields a reading and NOT a live weight (no double report).
- An implausible settling weight is dropped.
- Mutation: removing the emit fails a test.

## Review notes to check after implementing
- Does any exporter path accept a bare `{weight}`? If yes the barrier is fake.
- Does the grace-timer path treat a live weight as a held reading? It must not.
