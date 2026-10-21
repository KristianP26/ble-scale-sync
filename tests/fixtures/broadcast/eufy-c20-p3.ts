import type { AdvertFixture } from '../../helpers/replay/broadcast.js';

/**
 * Eufy Smart Scale C20 / P3 adverts (#408, D053). Frames from the Home
 * Assistant debug logs owners posted in bdr99/eufylife-ble-client #3 and #5,
 * as cited in tests/scales/eufy-c20-p3.test.ts (comment ids and log lines
 * there and in each source below); times are the log's, from the first line
 * used. Rewritten: the unit's address, which the scale echoes in the company
 * id's high byte and [0..4], is the harness's fake 02:00:00:00:00:01 (high
 * byte 0x02, [0..4] 00 00 00 00 01); the company id's low byte is kept.
 * Nothing else changed unless a source says so.
 */

const C20 = { localName: 'eufy T9130' };
const P3 = { localName: 'eufy T9150' };
const C20_LOCK = '000000000100c5c9706705001a2700000000';

export const adverts: AdvertFixture = {
  adapter: 'Eufy Smart Scale C20/P3',
  traces: {
    'eufy-c20-weigh-in': {
      provenance: 'captured',
      source:
        'eufylife-ble-client#5 comment 2564606224, lines 4-23; host clock set to the log time',
      device: C20,
      // Line 4 at 12:02:08.895 (UTC+8); the scale clock is within a second of it.
      now: Date.parse('2024-12-29T04:02:08.895Z'),
      adverts: [
        { atMs: 0, mfr: [0x0264, '000000000100c0c970670000000000000000'] },
        { atMs: 168, mfr: [0x0264, '000000000100c0c970670d00000000000000'] },
        { atMs: 3035, mfr: [0x0264, '000000000100c3c9706701001a2700000000'] },
        { atMs: 5302, mfr: [0x0264, C20_LOCK] },
        { atMs: 7350, mfr: [0x0264, '000000000100c7c9706715001a2700000000'] },
        { atMs: 8873, mfr: [0x0264, '000000000100c9c9706725801a27000000641104038a0000'] },
        { atMs: 35701, mfr: [0x0264, '000000000100e2c970670d40000000000000'] },
      ],
    },
    'eufy-c20-tap': {
      provenance: 'captured',
      source: 'eufylife-ble-client#5 comment 2698363321, lines 7, 8, 17: a tap, no final frame',
      device: C20,
      adverts: [
        { atMs: 0, mfr: [0x0264, '0000000001008631c7670100310100000000'] },
        { atMs: 308, mfr: [0x0264, '0000000001008631c7670d00000000000000'] },
        { atMs: 15657, mfr: [0x0264, '0000000001009131c7670d40000000000000'] },
      ],
    },
    'eufy-p3-weigh-in': {
      provenance: 'derived',
      source:
        'eufylife-ble-client#3 comment 2564412265, lines 15-32 under 0xCF4D; the seven 0x65 ' +
        'frames (lines 21-25, 29, 30) spaced evenly between their first and last log time',
      device: P3,
      now: Date.parse('2024-12-28T19:19:08.600Z'),
      adverts: [
        { atMs: 0, mfr: [0x024d, '0000000001002c4f706705005820000000000000000000'] },
        { atMs: 3645, mfr: [0x024d, '0000000001002f4f7067250058200000000b143534d900'] },
        { atMs: 6310, mfr: [0x024d, '000000000100324f7067650058200000000b143534d900'] },
        { atMs: 7248, mfr: [0x024d, '000000000100334f7067650058200000000b143534d900'] },
        { atMs: 8186, mfr: [0x024d, '000000000100344f7067650058200000000b143534d900'] },
        { atMs: 9124, mfr: [0x024d, '000000000100354f7067650058200000000b143534d900'] },
        { atMs: 10062, mfr: [0x024d, '000000000100364f7067650058200000000b143534d900'] },
        { atMs: 11000, mfr: [0x024d, '000000000100374f7067650058200000000b143534d900'] },
        { atMs: 11939, mfr: [0x024d, '000000000100384f7067650058200000000b143534d900'] },
        { atMs: 12741, mfr: [0x024d, '000000000100384f7067a5805820005f000b143534d900'] },
      ],
    },
    'eufy-p3-clock-never-set': {
      provenance: 'captured',
      source:
        'eufylife-ble-client#3 comment 2870205491, lines 8 (0xCF53), 55 and 72 (0xCF5D): the ' +
        'scale clock reads 2022, so the reading is dated by receipt',
      device: P3,
      adverts: [
        { atMs: 0, mfr: [0x0253, '000000000100c6d0f9610d400000010000000000000000'] },
        { atMs: 3684, mfr: [0x025d, '00000000010058d6f9610500c71a010000000000000000'] },
        { atMs: 7526, mfr: [0x025d, '0000000001005cd6f9612500c71a010000fe10dcd6e300'] },
      ],
    },
    'eufy-p3-nameless': {
      provenance: 'captured',
      source:
        'eufylife-ble-client#3 comment 2873299889, lines 11, 13, 18 under 0xCF45; no name, ' +
        'claimed on the address echo',
      adverts: [
        { atMs: 0, mfr: [0x0245, '0000000001006b7421680d400000000000000000000000'] },
        { atMs: 5683, mfr: [0x0245, '0000000001008025226801002030000000000000000000'] },
        { atMs: 16489, mfr: [0x0245, '0000000001008c25226825800c30000000eb10f1f73500'] },
      ],
    },
    'eufy-p3-heart-rate': {
      provenance: 'captured',
      source:
        'eufylife-ble-client#3 comment 3369241833, lines 67 and 121; the log has neither ' +
        'address nor company id, 0x024D stands in (only its high byte is read)',
      device: P3,
      adverts: [
        { atMs: 0, mfr: [0x024d, '00000000010027b6e2682500a717000000d5145f55ab00'] },
        { atMs: 8082, mfr: [0x024d, '00000000010032b6e268a580a717004800d5145f55ab00'] },
      ],
    },
    'eufy-c20-repeat-window': {
      provenance: 'derived',
      source:
        'eufylife-ble-client#5 comment 2564606224 line 19, its scale clock moved +60 s and ' +
        '+121 s: held back within 60 s of the last final frame, handed out after',
      device: C20,
      adverts: [
        { atMs: 0, mfr: [0x0264, C20_LOCK] },
        { atMs: 60_000, mfr: [0x0264, '00000000010001ca706705001a2700000000'] },
        { atMs: 121_000, mfr: [0x0264, '0000000001003eca706705001a2700000000'] },
      ],
    },
    'eufy-unknown-status': {
      provenance: 'derived',
      source:
        '#5 line 19 with [10] 0x05 -> 0x45 (warned once); #3 comment 2564412265 line 32 with ' +
        '[10] 0xA5 -> 0xE5 after its own weigh-in (debug only)',
      device: P3,
      adverts: [
        { atMs: 0, mfr: [0x0264, '000000000100c5c9706745001a2700000000'] },
        { atMs: 500, mfr: [0x0264, '000000000100c5c9706745001a2700000000'] },
        { atMs: 1000, mfr: [0x024d, '000000000100384f7067a5805820005f000b143534d900'] },
        { atMs: 1500, mfr: [0x024d, '000000000100384f7067e5805820005f000b143534d900'] },
      ],
    },
  },
};
