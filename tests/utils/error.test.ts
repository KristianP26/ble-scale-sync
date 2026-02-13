import { describe, it, expect } from 'vitest';
import { errMsg } from '../../src/utils/error.js';

describe('errMsg()', () => {
  it('extracts message from Error instance', () => {
    expect(errMsg(new Error('something broke'))).toBe('something broke');
  });

  it('converts string to itself', () => {
    expect(errMsg('plain string')).toBe('plain string');
  });

  it('converts number to string', () => {
    expect(errMsg(404)).toBe('404');
  });

  it('converts null to string', () => {
    expect(errMsg(null)).toBe('null');
  });

  it('converts undefined to string', () => {
    expect(errMsg(undefined)).toBe('undefined');
  });

  it('converts object to string', () => {
    expect(errMsg({ code: 'ENOENT' })).toBe('[object Object]');
  });

  it('handles TypeError subclass', () => {
    expect(errMsg(new TypeError('invalid type'))).toBe('invalid type');
  });
});
