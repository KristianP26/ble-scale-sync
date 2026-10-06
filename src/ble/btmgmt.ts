// Reading what btmgmt printed. Shared by the adapter reset in types.ts and by
// ble.adapter_privacy, because btmgmt's exit status says nothing: it exits 0
// when the kernel rejects a setting (setting_rsp in bluez client/mgmt.c), and
// prints the rejection in red on the same stdout as a success. Kept free of
// imports so types.ts can use it without a cycle.

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** btmgmt prints its errors in red through the same stdout as everything else. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export interface BtmgmtSettings {
  supported: string[];
  current: string[];
}

/**
 * Parse `btmgmt --index N info`. The settings lines are space-separated
 * tokens, matched whole: `ll-privacy` is a different setting from `privacy`.
 * Undefined when either line is missing, which is what a failed read prints.
 */
export function parseBtmgmtSettings(stdout: string): BtmgmtSettings | undefined {
  const text = stripAnsi(stdout);
  const supported = /^\s*supported settings:(.*)$/m.exec(text);
  const current = /^\s*current settings:(.*)$/m.exec(text);
  if (!supported || !current) return undefined;
  const tokens = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);
  return { supported: tokens(supported[1]), current: tokens(current[1]) };
}

/** The first line btmgmt printed as an error, for a message a user can act on. */
export function btmgmtErrorLine(out: string): string | undefined {
  return stripAnsi(out)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /failed|invalid|unable|denied|not supported/i.test(l));
}
