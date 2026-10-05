import { describe, it, expect } from 'vitest';
import { scriptedPrompts } from '../helpers/scripted-prompts.js';

// A scripted answer the prompt cannot take used to fall through to the
// default silently, so a test could pass down the path it meant to avoid.
describe('scriptedPrompts records an answer that does not fit its prompt', () => {
  const choices = [
    { name: 'A', value: 'a' },
    { name: 'B', value: 'b' },
  ];

  it('a select value that is not a choice', async () => {
    const s = scriptedPrompts([[/pick/, 'c']]);
    expect(await s.prompts.select('pick', choices)).toBe('a');
    expect(s.rejected).toEqual([expect.stringMatching(/^pick "c": matches none of/)]);
  });

  it('a checkbox value that is not a choice, or not a list', async () => {
    const s = scriptedPrompts([
      [/tick/, ['b', 'z']],
      [/again/, 'b'],
    ]);
    expect(await s.prompts.checkbox('tick', choices)).toEqual(['b']);
    expect(await s.prompts.checkbox('again', choices)).toEqual([]);
    expect(s.rejected).toEqual([
      expect.stringMatching(/^tick .*\["z"\] not among/),
      expect.stringMatching(/^again "b": not a list/),
    ]);
  });

  it('a string for a confirm and a boolean for an input or password', async () => {
    const s = scriptedPrompts([
      [/sure/, 'yes'],
      [/name/, true],
      [/secret/, false],
    ]);
    expect(await s.prompts.confirm('sure', { default: true })).toBe(true);
    expect(await s.prompts.input('name', { default: 'x' })).toBe('x');
    expect(await s.prompts.password('secret')).toBe('');
    expect(s.rejected).toEqual([
      'sure "yes": not an answer for a confirm',
      'name true: not an answer for an input',
      'secret false: not an answer for a password',
    ]);
  });

  it('records nothing for answers that fit', async () => {
    const s = scriptedPrompts([
      [/pick/, 'b'],
      [/tick/, ['a']],
      [/sure/, false],
      [/name/, 'n'],
    ]);
    expect(await s.prompts.select('pick', choices)).toBe('b');
    expect(await s.prompts.checkbox('tick', choices)).toEqual(['a']);
    expect(await s.prompts.confirm('sure', { default: true })).toBe(false);
    expect(await s.prompts.input('name')).toBe('n');
    expect(s.rejected).toEqual([]);
  });
});
