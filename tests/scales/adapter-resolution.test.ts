import { describe, it, expect } from 'vitest';
import { adapters } from '../../src/scales/index.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';

// Regression for #177: a Eufy/1byone T9146 advertises name "eufy T9146" and the
// generic 0xFFF0 vendor service. Before the fix, Inlife (earlier in the adapter
// array) shadowed the 1byone adapter via its bare 0xFFF0 fallback. Once
// characteristics are known post-discovery, Inlife must yield so the device
// resolves to "1byone (Eufy)".
describe('adapter resolution (#177 0xFFF0 collision)', () => {
  it('resolves a T9146 (name + 0xFFF1/0xFFF4 chars) to "1byone (Eufy)"', () => {
    const info: BleDeviceInfo = {
      localName: 'eufy T9146',
      serviceUuids: [uuid16(0xfff0)],
      characteristicUuids: [uuid16(0xfff1), uuid16(0xfff4)],
    };
    const matched = adapters.find((a) => a.matches(info));
    expect(matched?.name).toBe('1byone (Eufy)');
  });

  it('does not regress a real Inlife device (known name) -> "Inlife"', () => {
    const info: BleDeviceInfo = {
      localName: '000fatscale01',
      serviceUuids: [uuid16(0xfff0)],
      characteristicUuids: [uuid16(0xfff1), uuid16(0xfff2)],
    };
    const matched = adapters.find((a) => a.matches(info));
    expect(matched?.name).toBe('Inlife');
  });

  // #168: BF720 exposes Body Composition 0x181B post-connect (shared with Mi
  // Scale 2) and advertises Beurer company id 0x0611. It must resolve to the
  // Beurer adapter, not "Xiaomi Mi Scale 2".
  it('resolves a BF720 (Beurer cid 0x0611 + 0x181B) to the Beurer adapter', () => {
    const info: BleDeviceInfo = {
      localName: 'BF720',
      serviceUuids: [uuid16(0x181d), uuid16(0x181b)],
      manufacturerData: { id: 0x0611, data: Buffer.alloc(0) },
    };
    const matched = adapters.find((a) => a.matches(info));
    expect(matched?.name).toBe('Beurer BF720/BF105');
  });
});

// Regression for #235: a GE CS 10 G ("Fit Plus") advertises a non-QN name and
// BOTH the fff0 cluster (fff0/fff1/fff2) and the QN-only AE00 cluster
// (ae00/ae01/ae02). Before the fix the QN adapter ignored AE00 and rejected the
// named device, so the registry-later Inlife adapter grabbed it via its bare
// fff0 fallback and drove the wrong fff1/fff2 protocol. AE00 must resolve to QN.
describe('adapter resolution (#235 fff0+ae00 QN/Inlife collision)', () => {
  it('resolves a "Fit Plus" (name + fff0 + ae00 service) to "QN Scale"', () => {
    const info: BleDeviceInfo = {
      localName: 'Fit Plus',
      serviceUuids: [
        uuid16(0x1800),
        uuid16(0x180f),
        uuid16(0x180a),
        uuid16(0xfff0),
        uuid16(0xae00),
      ],
    };
    const matched = adapters.find((a) => a.matches(info));
    expect(matched?.name).toBe('QN Scale');
  });

  it('resolves a "Fit Plus" via ae01/ae02 characteristics (no top-level ae00 service)', () => {
    const info: BleDeviceInfo = {
      localName: 'Fit Plus',
      serviceUuids: [uuid16(0xfff0)],
      characteristicUuids: [uuid16(0xfff1), uuid16(0xfff2), uuid16(0xae01), uuid16(0xae02)],
    };
    const matched = adapters.find((a) => a.matches(info));
    expect(matched?.name).toBe('QN Scale');
  });

  it('does not regress a real Inlife device without AE00 -> "Inlife"', () => {
    const info: BleDeviceInfo = {
      localName: '000fatscale01',
      serviceUuids: [uuid16(0xfff0)],
      characteristicUuids: [uuid16(0xfff1), uuid16(0xfff2)],
    };
    const matched = adapters.find((a) => a.matches(info));
    expect(matched?.name).toBe('Inlife');
  });
});

// Regression for #232: the Xiaomi Mijia S800 advertises encrypted MiBeacon in
// FE95 service data carrying product id 0x51E2. It must resolve to the S800
// adapter (no other adapter reads FE95).
describe('adapter resolution (#232 Xiaomi S800 FE95)', () => {
  it('resolves a Xiaomi S800 FE95 advertisement to the S800 adapter', () => {
    const info: BleDeviceInfo = {
      localName: 'Mijia Scale S800 A1AB',
      serviceUuids: [],
      serviceData: [
        { uuid: 'fe95', data: Buffer.from([0x58, 0x59, 0xe2, 0x51, 0x5b, 0, 0, 0, 0, 0, 0]) },
      ],
    };
    const matched = adapters.find((a) => a.matches(info));
    expect(matched?.name).toBe('Xiaomi Mijia Scale S800');
  });
});
