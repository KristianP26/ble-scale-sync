/**
 * Take a copy of process.env and return a function that puts it back: keys
 * added since are deleted, changed ones restored. vi.unstubAllEnvs only
 * restores names a test stubbed, and the wizard's offerEnvSecret sets
 * process.env itself, so without this a stored secret leaked into every later
 * test in the worker.
 */
export function snapshotEnv(): () => void {
  const before = new Map(Object.entries(process.env));
  return () => {
    for (const key of Object.keys(process.env)) {
      if (!before.has(key)) delete process.env[key];
    }
    for (const [key, value] of before) {
      if (process.env[key] !== value) process.env[key] = value;
    }
  };
}
