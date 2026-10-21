import { describe, it, expect } from 'vitest';
import { e1, jieliAuthResponseFrame } from '../../src/scales/qn-scale/jieli-auth.js';

const h = (s: string): Buffer => Buffer.from(s, 'hex');

describe('jieli-auth', () => {
  describe('E1 primitive', () => {
    // Bluetooth Core specification, Vol 2 Part H, "FOUR TESTS OF E1".
    // These pin the SAFER+ primitive independently of any vendor data: if the
    // key schedule, Ar' round-3 feedback or key offset drift, these fail first
    // and the JieLi vectors below cannot tell you which part broke.
    const specVectors: Array<[key: string, addr: string, rand: string, expected: string]> = [
      [
        '00000000000000000000000000000000',
        '000000000000',
        '00000000000000000000000000000000',
        '056c0fe648afcdd4bd40fef76693b113',
      ],
      [
        '159dd9f43fc3d328efba0cd8a861fa57',
        '7ca89b233c2d',
        'bc3f30689647c8d7c5a03ca80a91eceb',
        '8d5205c53ed75df4abd9af638d144e94',
      ],
      [
        '45298d06e46bac21421ddfbed94c032b',
        'c62f19f6ce98',
        '0891caee063f5da1809577ff94ccdcfb',
        '00507e5f2a5f19fbf60907e69f39ca9f',
      ],
      [
        '35949a914225fabad91995d226de1d92',
        'f428f0e624b3',
        '0ecd61782b4128480c05dc45542b1b8c',
        '80e5629ca6fe4dcde3924611d3cc6ba1',
      ],
    ];

    it.each(specVectors)('matches the spec vector for key %s', (key, addr, rand, expected) => {
      expect(e1(h(key), h(rand), h(addr)).toString('hex')).toBe(expected);
    });

    it('rejects wrongly sized inputs', () => {
      expect(() => e1(h('00'), h('00'.repeat(16)), h('00'.repeat(6)))).toThrow(/key must be 16/);
      expect(() => e1(h('00'.repeat(16)), h('00'), h('00'.repeat(6)))).toThrow(/rand must be 16/);
      expect(() => e1(h('00'.repeat(16)), h('00'.repeat(16)), h('00'))).toThrow(/addr must be 6/);
    });
  });

  describe('AE00 challenge/response (#235)', () => {
    // Every challenge/response pair captured by @hedoric from five complete
    // vendor-app weigh-ins on a GE CS 10 G. Exchange A is app-to-scale (the
    // scale answers), exchange B is scale-to-app (the host must answer). Both
    // directions use the same transform, so all ten are usable here, and the
    // A pairs are what prove the scale itself runs this exact function.
    const captured: Array<[challenge: string, response: string]> = [
      ['4aec29cdbaabf2fbe3467cc254f81be8', 'b3833f209534f73681c0febecb85466d'],
      ['e78d765a2e63339fc99a66320db73158', 'ade992145ab89adf32a1188daf81cb96'],
      ['5a255d051758e95ed4abb2cdc69bb454', 'e33c7c6052d8f88cf4659a004e44ba11'],
      ['41213ddc8770e93ea141e1fc673e017e', '1d01910f7b913c816858e788d7250b10'],
      ['97eadc6b968f385c2aecb03bfb32af3c', '075b87ae03d1fac9ed1b54e761c0b47c'],
      ['b1852b27c416ae9cfcc074f6e557e1ad', '4c88b5e54afd87c42af758fc59cdf0d2'],
      ['b955ec4ca696e06ee993477a91b97fdf', '5358042a6b3951f66bf61f0d2786f722'],
      ['8c9a6ed2e94cf944265c482e87fc8376', '0916698330bc972260776984f1d4f29d'],
      ['f53ecda8bac0b6aabb6e7342b64e191a', '09a4693c5b62155f536999a90c299ae9'],
      ['e748bfaf532c3f6a4144ba5c661950ec', '7fb31bf5e63728facd1a7854063f5081'],
    ];

    it.each(captured)('answers the captured challenge %s', (challenge, response) => {
      // Full 17-byte frame as it arrives on AE02.
      const frame = Buffer.concat([Buffer.from([0x00]), h(challenge)]);
      const out = jieliAuthResponseFrame(frame);
      expect(out.length).toBe(17);
      expect(out[0]).toBe(0x01);
      expect(out.subarray(1).toString('hex')).toBe(response);
    });

    it('accepts a bare 16-byte challenge body', () => {
      const [challenge, response] = captured[0];
      const out = jieliAuthResponseFrame(h(challenge));
      expect(out.subarray(1).toString('hex')).toBe(response);
    });
  });
});
