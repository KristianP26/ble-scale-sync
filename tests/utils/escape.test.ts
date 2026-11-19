import { describe, it, expect } from 'vitest';
import { escapeControlChars, escapeForLog } from '../../src/utils/escape.js';
import { safeName } from '../../src/ble/advertisement.js';

describe('escapeControlChars (logger variant)', () => {
  it.each([
    ['plain text', 'plain text'],
    ['a\nb', 'a\nb'],
    ['a\tb', 'a\tb'],
    ['a\r\nb', 'a\nb'],
    ['a\rb', 'a\\x0db'],
    ['a\x1bb', 'a\\x1bb'],
    ['a\x00b', 'a\\x00b'],
    ['a\x7fb', 'a\\x7fb'],
    ['a\u009bb', 'a\\x9bb'],
    ['a\u2028b', 'a\\u2028b'],
    ['a\u2029b', 'a\\u2029b'],
    ['C:\\Users\\x', 'C:\\Users\\x'],
    ['\u00e9\u4e2d', '\u00e9\u4e2d'],
  ])('%j -> %j', (input, expected) => {
    expect(escapeControlChars(input)).toBe(expected);
  });
});

describe('escapeForLog (strict variant)', () => {
  it.each([
    ['plain text', 'plain text'],
    ['a\nb', 'a\\x0ab'],
    ['a\tb', 'a\\x09b'],
    ['a\r\nb', 'a\\x0d\\x0ab'],
    ['a\\b', 'a\\x5cb'],
    ['a\x1bb', 'a\\x1bb'],
    ['a\u2028b', 'a\\u2028b'],
  ])('%j -> %j', (input, expected) => {
    expect(escapeForLog(input)).toBe(expected);
  });

  it('is what safeName returns', () => {
    for (const x of ['', 'Scale', 'a\\b\nc', '\x1b[2J', 'x\u2028y', '\u009dosc', 'a\x7f']) {
      expect(safeName(x)).toBe(escapeForLog(x));
    }
  });
});
