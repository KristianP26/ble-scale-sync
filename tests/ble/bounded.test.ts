import { describe, it, expect } from 'vitest';
import { BoundedMap, BoundedSet } from '../../src/ble/advertisement.js';

describe('BoundedMap and BoundedSet', () => {
  it('fifo: a key set again keeps its place, the oldest goes first', () => {
    const m = new BoundedMap<string, number>(2, 'fifo');
    m.set('a', 1);
    m.set('b', 2);
    m.set('a', 3);
    m.set('c', 4);
    expect([...m]).toEqual([
      ['b', 2],
      ['c', 4],
    ]);
  });

  it('lru: a key set again becomes the newest', () => {
    const m = new BoundedMap<string, number>(2, 'lru');
    m.set('a', 1);
    m.set('b', 2);
    m.set('a', 3);
    m.set('c', 4);
    expect([...m]).toEqual([
      ['a', 3],
      ['c', 4],
    ]);
  });

  it('set: an old value added again keeps its place', () => {
    const s = new BoundedSet<string>(2);
    s.add('a').add('b').add('a').add('c');
    expect([...s]).toEqual(['b', 'c']);
  });
});
