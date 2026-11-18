import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  guardedListener,
  isPlainObject,
  parsePeerArray,
  parsePeerJson,
  parsePeerObject,
  peerText,
  reportPeerFault,
  warnThrottled,
  _resetPeerInput,
} from '../../src/ble/peer-input.js';
import { bleLog } from '../../src/ble/types.js';

let warn: ReturnType<typeof vi.spyOn>;
let debug: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  _resetPeerInput();
  warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
  debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('isPlainObject', () => {
  it.each([
    [{}, true],
    [{ a: 1 }, true],
    [null, false],
    [[], false],
    ['x', false],
    [5, false],
    [undefined, false],
  ])('%j -> %s', (value, expected) => {
    expect(isPlainObject(value)).toBe(expected);
  });
});

describe('parsePeerJson / parsePeerObject / parsePeerArray', () => {
  it('parses a string and a Buffer', () => {
    expect(parsePeerJson('{"a":1}', 100)).toEqual({ ok: true, value: { a: 1 } });
    expect(parsePeerJson(Buffer.from('[1]'), 100)).toEqual({ ok: true, value: [1] });
  });

  it('reports syntax errors without the input', () => {
    expect(parsePeerJson('{not json', 100)).toEqual({ ok: false, why: 'not valid JSON' });
    expect(parsePeerJson(Buffer.from([0xff, 0xfe, 0x00]), 100)).toEqual({
      ok: false,
      why: 'not valid JSON',
    });
  });

  it('refuses an input over the limit before parsing it', () => {
    const spy = vi.spyOn(JSON, 'parse');
    expect(parsePeerJson(Buffer.alloc(11, 0x20), 10)).toEqual({
      ok: false,
      why: 'too large (11 bytes)',
    });
    expect(parsePeerJson('x'.repeat(11), 10)).toEqual({ ok: false, why: 'too large (11 bytes)' });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([['null'], ['[]'], ['"x"'], ['5'], ['true']])('object parser rejects %s', (raw) => {
    expect(parsePeerObject(raw, 100)).toEqual({ ok: false, why: 'not a JSON object' });
  });

  it.each([['null'], ['{}'], ['"x"'], ['5']])('array parser rejects %s', (raw) => {
    expect(parsePeerArray(raw, 100)).toEqual({ ok: false, why: 'not a JSON array' });
  });

  it('accepts an object and an array', () => {
    expect(parsePeerObject('{"a":1}', 100)).toEqual({ ok: true, value: { a: 1 } });
    expect(parsePeerArray('[1,2]', 100)).toEqual({ ok: true, value: [1, 2] });
  });
});

describe('peerText', () => {
  it('escapes CRLF, ESC, LF and backslash', () => {
    expect(peerText('online\r\n2026 [BLE] FAKE\x1b[2J\\')).toBe(
      'online\\x0d\\x0a2026 [BLE] FAKE\\x1b[2J\\x5c',
    );
  });

  it('cuts to the limit before escaping and marks the cut', () => {
    expect(peerText('a'.repeat(300), 10)).toBe('aaaaaaaaaa...');
    expect(peerText('\x1b'.repeat(20), 5)).toBe('\\x1b\\x1b\\x1b\\x1b\\x1b...');
  });

  it('decodes only as many bytes of a Buffer as the limit can need', () => {
    const big = Buffer.alloc(10_000_000, 0x41);
    expect(peerText(big, 8)).toBe('AAAAAAAA...');
  });

  it('handles non-strings', () => {
    expect(peerText(null)).toBe('null');
    expect(peerText({ a: 1 })).toBe('{"a":1}');
    expect(peerText(undefined)).toBe('undefined');
  });
});

describe('warnThrottled / reportPeerFault', () => {
  it('warns once a minute, then logs debug, then says how many were held back', () => {
    for (let i = 0; i < 50; i++) warnThrottled('k', 'bad');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledTimes(49);
    vi.advanceTimersByTime(60_000);
    warnThrottled('k', 'bad');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toBe('bad (49 more in the last minute)');
  });

  it('throttles per key', () => {
    warnThrottled('a', 'x');
    warnThrottled('b', 'y');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('warns at once when the variant changes inside the window', () => {
    warnThrottled('k', 'connect ETIMEDOUT', { variant: 'connect ETIMEDOUT' });
    warnThrottled('k', 'connect ETIMEDOUT', { variant: 'connect ETIMEDOUT' });
    expect(warn).toHaveBeenCalledTimes(1);
    warnThrottled('k', 'Invalid password', { variant: 'Invalid password' });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('logs to the logger it is given', () => {
    const other = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    warnThrottled('k', 'first', { log: other });
    warnThrottled('k', 'second', { log: other });
    expect(other.warn).toHaveBeenCalledWith('first');
    expect(other.debug).toHaveBeenCalledWith('second');
    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it('reportPeerFault names the kind and the peer and escapes the detail', () => {
    reportPeerFault('the ESP32 proxy', 'scan result', 'bad\nline');
    expect(warn).toHaveBeenCalledWith(
      'Ignored a malformed scan result from the ESP32 proxy: bad\\x0aline',
    );
  });
});

describe('guardedListener', () => {
  it('passes every argument through', () => {
    const fn = vi.fn();
    guardedListener('p', 'w', fn)('a', 'b', { retain: true });
    expect(fn).toHaveBeenCalledWith('a', 'b', { retain: true });
  });

  it('does not let an exception escape and reports it as a failure, not a bad message', () => {
    const listener = guardedListener('the ESP32 proxy', 'notification', () => {
      throw new TypeError('boom');
    });
    expect(() => listener()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe(
      'Failed to handle a notification from the ESP32 proxy: boom',
    );
  });
});
