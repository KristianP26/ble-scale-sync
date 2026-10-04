import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { mergeIntoYaml } from '../../src/wizard/yaml-merge.js';

const USERS = `users:
  # Alice: the first scale user
  - name: Alice
    slug: alice
    height: 175
  # Bob: the second one
  - name: Bob
    slug: bob # do not rename
    height: 180
`;

describe('mergeIntoYaml', () => {
  // Matched by slug, two users with one slug (saved through "Save anyway?")
  // both took the first user's node, and Bob overwrote Alice.
  it('keeps both users when two of them share a slug', () => {
    const value = {
      users: [
        { name: 'Alice', slug: 'alice', height: 175 },
        { name: 'Bob', slug: 'alice', height: 180 },
      ],
    };

    const out = mergeIntoYaml(USERS, value);

    expect(parseYaml(out!)).toEqual(value);
  });

  it('keeps both users when the file already has a slug twice', () => {
    const raw = USERS.replace('slug: bob', 'slug: alice');
    const value = {
      users: [
        { name: 'Alice', slug: 'alice', height: 175 },
        { name: 'Bob', slug: 'bob', height: 181 },
      ],
    };

    const out = mergeIntoYaml(raw, value);

    expect(parseYaml(out!)).toEqual(value);
  });

  // yaml keeps the comment above the first item on the list, so removing the
  // first user put that user's comment above the next one.
  it('removes the comment of a removed first user', () => {
    const out = mergeIntoYaml(USERS, { users: [{ name: 'Bob', slug: 'bob', height: 180 }] })!;

    expect(out).not.toContain('Alice');
    expect(out).toContain('# Bob: the second one');
    expect(out).toContain('slug: bob # do not rename');
  });

  it('keeps the comment above the first user when nothing changes', () => {
    const value = parseYaml(USERS) as Record<string, unknown>;

    expect(mergeIntoYaml(USERS, value)).toBe(USERS);
  });

  // yaml attaches a comment that ends a nested block to that block, so
  // dropping the block dropped the comment that introduces the next key.
  it('keeps a comment that ends a dropped block', () => {
    const raw = `ble:
  handler: mqtt-proxy
  mqtt_proxy:
    broker_url: mqtt://x
    # The ESPHome proxy is the one in the garage.
  esphome_proxy:
    host: garage.local
`;

    const out = mergeIntoYaml(raw, {
      ble: { handler: 'esphome-proxy', esphome_proxy: { host: 'garage.local' } },
    })!;

    expect(out).not.toContain('mqtt_proxy');
    expect(out).toMatch(/# The ESPHome proxy is the one in the garage\.\n\s*esphome_proxy:/);
    expect(parseYaml(out)).toEqual({
      ble: { handler: 'esphome-proxy', esphome_proxy: { host: 'garage.local' } },
    });
  });

  it('keeps a comment that ends a dropped last block of a map', () => {
    const raw = `ble:
  handler: mqtt-proxy
  mqtt_proxy:
    broker_url: mqtt://x
    # Exporters below.
global_exporters:
  - type: file
`;

    const out = mergeIntoYaml(raw, {
      ble: { handler: 'auto' },
      global_exporters: [{ type: 'file' }],
    })!;

    expect(out).not.toContain('mqtt_proxy');
    expect(out).toContain('# Exporters below.');
  });
});
