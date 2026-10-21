import type { SessionFixture } from '../../helpers/replay/session.js';
import { fromSnoop, type SnoopLine } from '../../helpers/replay/trace.js';

/**
 * Beurer / Sanitas, BF710 / SBF70 / SBF75 layout (0xE7 frames on FFE1).
 *
 * Every session starts on a fresh instance whose matches() never ran, which is
 * the `ble.force_scale_adapter` path of #384: the variant latches from the
 * first 0xE7 frame. So the unlock is the BF700 `f7 01` for the whole session
 * (the command list is taken when the interval starts) and the 15 s hold
 * exists only from that frame on. A name-matched SBF70 (`e7 01` from the
 * start) cannot be replayed: the harness does not call matches().
 *
 * No address appears in any of these sources.
 */

/**
 * Official app HCI snoop, #211 comment 4626642448 (2026-06-04 23:57, Android).
 * `rx` = notification on handle 0x1b, `tx` = the app's Write Request on 0x12
 * (its INIT e6 01, time e9.., commands e7 33/40/43/46 and the per-frame ACKs
 * e7 f1 ..). Dropped: the scale's replies to those app commands (e6 00 20,
 * e7 f0 .., e7 07 12 58 00), since we never send the commands, and the e7 34
 * user record the reporter redacted.
 */
const ISSUE_211_APP_SNOOP: SnoopLine[] = [
  ['23:57:11.332', 'tx', 'e601'],
  ['23:57:11.488', 'tx', 'e96a21f4b7'],
  ['23:57:11.612', 'tx', 'e733'],
  ['23:57:11.699', 'tx', 'e733'],
  ['23:57:11.958', 'tx', 'e7f1340101'],
  ['23:57:13.511', 'tx', 'e7400000000000000065'],
  ['23:57:14.490', 'rx', 'e758010000'],
  ['23:57:14.512', 'tx', 'e7f1580100'],
  ['23:57:16.089', 'tx', 'e746'],
  ['23:57:17.491', 'rx', 'e7580100ad'],
  ['23:57:17.517', 'tx', 'e7f1580100'],
  ['23:57:17.640', 'rx', 'e7580102b2'],
  ['23:57:17.656', 'tx', 'e7f1580102'],
  ['23:57:17.790', 'rx', 'e758010528'],
  ['23:57:17.807', 'tx', 'e7f1580105'],
  ['23:57:17.890', 'rx', 'e75801064b'],
  ['23:57:17.907', 'tx', 'e7f1580106'],
  ['23:57:18.040', 'rx', 'e75801068f'],
  ['23:57:18.058', 'tx', 'e7f1580106'],
  ['23:57:18.190', 'rx', 'e758010672'],
  ['23:57:18.206', 'tx', 'e7f1580106'],
  ['23:57:18.290', 'rx', 'e758010676'],
  ['23:57:18.305', 'tx', 'e7f1580106'],
  ['23:57:18.440', 'rx', 'e758010685'],
  ['23:57:18.456', 'tx', 'e7f1580106'],
  ['23:57:18.540', 'rx', 'e75801067b'],
  ['23:57:18.556', 'tx', 'e7f1580106'],
  ['23:57:18.690', 'rx', 'e75801068a'],
  ['23:57:18.705', 'tx', 'e7f1580106'],
  ['23:57:18.840', 'rx', 'e758010682'],
  ['23:57:18.858', 'tx', 'e7f1580106'],
  ['23:57:18.940', 'rx', 'e758010683'],
  ['23:57:18.956', 'tx', 'e7f1580106'],
  ['23:57:19.092', 'rx', 'e75801068c'],
  ['23:57:19.109', 'tx', 'e7f1580106'],
  ['23:57:19.240', 'rx', 'e758010688'],
  ['23:57:19.259', 'tx', 'e7f1580106'],
  ['23:57:19.340', 'rx', 'e758010685'],
  ['23:57:19.355', 'tx', 'e7f1580106'],
  ['23:57:19.491', 'rx', 'e758010682'],
  ['23:57:19.508', 'tx', 'e7f1580106'],
  ['23:57:19.590', 'rx', 'e758010686'],
  ['23:57:19.608', 'tx', 'e7f1580106'],
  ['23:57:19.741', 'rx', 'e758010686'],
  ['23:57:19.759', 'tx', 'e7f1580106'],
  ['23:57:19.890', 'rx', 'e758010687'],
  ['23:57:19.911', 'tx', 'e7f1580106'],
  ['23:57:19.990', 'rx', 'e758010686'],
  ['23:57:20.006', 'tx', 'e7f1580106'],
  ['23:57:20.140', 'rx', 'e758010680'],
  ['23:57:20.155', 'tx', 'e7f1580106'],
  ['23:57:20.290', 'rx', 'e758010687'],
  ['23:57:20.308', 'tx', 'e7f1580106'],
  ['23:57:20.390', 'rx', 'e758010687'],
  ['23:57:20.406', 'tx', 'e7f1580106'],
  ['23:57:20.541', 'rx', 'e758010688'],
  ['23:57:20.558', 'tx', 'e7f1580106'],
  ['23:57:20.640', 'rx', 'e758010687'],
  ['23:57:20.656', 'tx', 'e7f1580106'],
  ['23:57:20.791', 'rx', 'e758010687'],
  ['23:57:20.808', 'tx', 'e7f1580106'],
  ['23:57:21.098', 'tx', 'e746'],
  ['23:57:22.690', 'rx', 'e758000687'],
  ['23:57:22.719', 'tx', 'e7f1580006'],
  ['23:57:26.096', 'tx', 'e746'],
  ['23:57:27.742', 'rx', 'e7590301010000000000000065'],
  ['23:57:27.770', 'tx', 'e7f1590301'],
  ['23:57:27.840', 'rx', 'e75903026a21f4c6068701b500df02'],
  ['23:57:27.864', 'tx', 'e7f1590302'],
  ['23:57:27.940', 'rx', 'e759030309018d00e907170aa20108'],
  ['23:57:28.013', 'tx', 'e7f1590303'],
];

/**
 * Our v1.26.0 debug log over an ESPHome proxy, #384 issue body (SBF70, adapter
 * forced). `tx` is that build's own unlock, not a vendor app write.
 */
const ISSUE_384_LIVE: SnoopLine[] = [
  ['09:39:16.259', 'tx', 'f701'],
  ['09:39:26.595', 'rx', 'e75801011d'],
  ['09:39:26.808', 'rx', 'e758010709'],
  ['09:39:27.692', 'rx', 'e75801070a'],
  ['09:39:28.914', 'rx', 'e758010713'],
  ['09:39:29.888', 'rx', 'e758010710'],
  ['09:39:30.883', 'rx', 'e758010713'],
  ['09:39:31.900', 'rx', 'e758010712'],
  ['09:39:32.915', 'rx', 'e75801070f'],
  ['09:39:33.983', 'rx', 'e758010710'],
  ['09:39:34.953', 'rx', 'e758010710'],
  ['09:39:36.099', 'rx', 'e758010712'],
  ['09:39:37.029', 'rx', 'e758010712'],
  ['09:39:38.138', 'rx', 'e758010712'],
  ['09:39:39.252', 'rx', 'e7580106f8'],
  ['09:39:40.378', 'rx', 'e758010000'],
];

/**
 * Our capture-mode log, #211 comment 4625892076 (2026-06-04 20:33, SBF70 on a
 * Pi): the live frames, then part 1 of the 0x59 stream and nothing after it,
 * because that build sent no ACK.
 */
const ISSUE_211_PI_LOG: SnoopLine[] = [
  ['20:33:20.079', 'rx', 'e758010160'],
  ['20:33:21.272', 'rx', 'e758010680'],
  ['20:33:22.066', 'rx', 'e758010689'],
  ['20:33:23.060', 'rx', 'e758010685'],
  ['20:33:24.253', 'rx', 'e758010685'],
  ['20:33:25.445', 'rx', 'e758010685'],
  ['20:33:26.637', 'rx', 'e758010686'],
  ['20:33:27.036', 'rx', 'e758010686'],
  ['20:33:28.427', 'rx', 'e758000686'],
  ['20:33:29.817', 'rx', 'e758000686'],
  ['20:33:35.184', 'rx', 'e7590301010000000000000065'],
];

export const session: SessionFixture = {
  adapter: 'Beurer / Sanitas',
  persists: {
    keys: ['writes'],
    why:
      'isBf710Type stays latched across sessions on purpose (onSessionStart comment, #384): ' +
      'a used instance unlocks with e7 01 where a fresh one sends f7 01',
  },
  traces: {
    // Stable weight held 15 s; the ACKed 0x59 stream lands inside it: 437 ohm.
    'issue-211-app-snoop': {
      provenance: 'derived',
      source:
        '#211 comment 4626642448 HCI snoop; replies to app-only commands and the redacted e7 34 dropped',
      steps: fromSnoop(ISSUE_211_APP_SNOOP),
    },
    // Weight-only: the stability gate, then the hold runs out with no 0x59.
    'issue-384-esphome-live': {
      provenance: 'captured',
      source: '#384 issue body, v1.26.0 DEBUG log',
      steps: fromSnoop(ISSUE_384_LIVE),
    },
    // The finalize part 1 alone, once read as 12.80 kg: today no reading.
    'issue-384-finalize-part-1-only': {
      provenance: 'captured',
      source: '#384 issue body, later weigh-in (09:44:23.464)',
      steps: fromSnoop([['09:44:23.464', 'rx', 'e7590301010000000000000065']]),
    },
    // Part 1 arrives inside the hold and the parts after it never do: the hold
    // is extended in 5 s steps and still ends weight-only.
    'issue-211-pi-part-1-never-continued': {
      provenance: 'captured',
      source: '#211 comment 4625892076, capture-mode log',
      steps: fromSnoop(ISSUE_211_PI_LOG),
    },
    // An unregistered user: parts 2 and 3 all zero, so weight-only at the hold end.
    'unregistered-zero-composition': {
      provenance: 'derived',
      source:
        '#211 app snoop frames 23:57:20.390-20.791 and part 1; parts 2/3 zeroed as in tests/scales/beurer-sanitas.test.ts',
      steps: fromSnoop([
        ['00:00:00.000', 'rx', 'e758010687'],
        ['00:00:00.150', 'rx', 'e758010688'],
        ['00:00:00.250', 'rx', 'e758010687'],
        ['00:00:00.400', 'rx', 'e758010687'],
        ['00:00:07.000', 'rx', 'e7590301010000000000000065'],
        ['00:00:07.100', 'rx', 'e75903026a21f4c600000000000000'],
        ['00:00:07.200', 'rx', 'e75903030000000000000000000000'],
      ]),
    },
  },
};
