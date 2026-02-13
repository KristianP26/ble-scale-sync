import { describe, it, expect } from 'vitest';
import { generateSlug, validateSlugUniqueness } from '../../src/config/slugify.js';

// ─── generateSlug() ────────────────────────────────────────────────────────

describe('generateSlug()', () => {
  it('converts to lowercase', () => {
    expect(generateSlug('Dad')).toBe('dad');
  });

  it('replaces spaces with hyphens', () => {
    expect(generateSlug('Mama Janka')).toBe('mama-janka');
  });

  it('strips diacritics (NFD normalization)', () => {
    expect(generateSlug('José María')).toBe('jose-maria');
  });

  it('strips Czech diacritics', () => {
    expect(generateSlug('Křištof Říha')).toBe('kristof-riha');
  });

  it('strips German umlauts', () => {
    expect(generateSlug('Müller Böhm')).toBe('muller-bohm');
  });

  it('replaces underscores with hyphens', () => {
    expect(generateSlug('my_user_name')).toBe('my-user-name');
  });

  it('removes non-alphanumeric characters', () => {
    expect(generateSlug("John's Scale!")).toBe('johns-scale');
  });

  it('collapses multiple hyphens', () => {
    expect(generateSlug('a - b -- c')).toBe('a-b-c');
  });

  it('trims leading and trailing hyphens', () => {
    expect(generateSlug(' -hello- ')).toBe('hello');
  });

  it('handles numbers', () => {
    expect(generateSlug('User 1')).toBe('user-1');
  });

  it('handles already-valid slug', () => {
    expect(generateSlug('dad')).toBe('dad');
  });

  it('handles empty string', () => {
    expect(generateSlug('')).toBe('');
  });

  it('handles string with only special characters', () => {
    expect(generateSlug('!@#$%')).toBe('');
  });

  it('handles CJK characters (stripped to empty)', () => {
    expect(generateSlug('日本語')).toBe('');
  });

  it('handles mixed ASCII and unicode', () => {
    expect(generateSlug('User 日本語 Test')).toBe('user-test');
  });

  it('handles emoji (stripped)', () => {
    expect(generateSlug('Dad 💪')).toBe('dad');
  });

  it('handles multiple consecutive spaces', () => {
    expect(generateSlug('a   b   c')).toBe('a-b-c');
  });

  it('handles tabs', () => {
    expect(generateSlug('a\tb')).toBe('a-b');
  });
});

// ─── validateSlugUniqueness() ──────────────────────────────────────────────

describe('validateSlugUniqueness()', () => {
  it('returns empty array when all slugs are unique', () => {
    expect(validateSlugUniqueness(['dad', 'mom', 'kid'])).toEqual([]);
  });

  it('detects a single duplicate', () => {
    expect(validateSlugUniqueness(['dad', 'mom', 'dad'])).toEqual(['dad']);
  });

  it('detects multiple duplicates', () => {
    const result = validateSlugUniqueness(['dad', 'mom', 'dad', 'mom', 'kid']);
    expect(result).toContain('dad');
    expect(result).toContain('mom');
    expect(result).toHaveLength(2);
  });

  it('reports each duplicate only once', () => {
    expect(validateSlugUniqueness(['a', 'a', 'a'])).toEqual(['a']);
  });

  it('returns empty for empty input', () => {
    expect(validateSlugUniqueness([])).toEqual([]);
  });

  it('returns empty for single slug', () => {
    expect(validateSlugUniqueness(['only'])).toEqual([]);
  });
});
