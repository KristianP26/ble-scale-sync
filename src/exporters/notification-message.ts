import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { ExportContext } from '../interfaces/exporter.js';
import { fmtWeight } from '../runtime/format.js';
import { redactSecrets } from '../utils/error.js';

/** Message body shared by the push notification exporters (ntfy, telegram). */
export function formatNotification(data: BodyComposition, context?: ExportContext): string {
  const unit = context?.weightUnit ?? 'kg';
  const prefix = context?.userName ? `[${context.userName}] ` : '';
  const pct = (v: number | null | undefined): string | null =>
    v == null ? null : `${v.toFixed(1)}%`;
  const mass = (v: number | null): string | null => (v === null ? null : fmtWeight(v, unit));
  const part = (label: string, value: string | number | null | undefined): string | null =>
    value == null ? null : `${label} ${value}`;
  // A value that is not there is left out of its line, and a line with
  // nothing left goes too: a withheld composition value is null, and only a
  // scale that measured it sends a skeletal muscle percentage (#497).
  const line = (emoji: string, ...parts: Array<string | null>): string | null => {
    const present = parts.filter((p): p is string => p !== null);
    return present.length ? `${emoji} ${present.join(' | ')}` : null;
  };
  const lines = [
    `${prefix}⚖️ ${fmtWeight(data.weight, unit)} | BMI ${data.bmi.toFixed(1)}`,
    line(
      '🏋️',
      part('Body Fat', pct(data.bodyFatPercent)),
      part('Muscle', mass(data.muscleMass)),
      part('Skeletal', pct(data.skeletalMusclePercent)),
    ),
    line('💧', part('Water', pct(data.waterPercent)), part('🦴 Bone', mass(data.boneMass))),
    line('🫀', part('Visceral Fat', data.visceralFat), `BMR ${data.bmr} kcal`),
    line('📅', `Metabolic Age ${data.metabolicAge} yr`, part('Physique', data.physiqueRating)),
  ].filter((l): l is string => l !== null);
  if (context?.driftWarning) {
    lines.push(`⚠️ ${context.driftWarning}`);
  }
  for (const r of context?.exportResults ?? []) {
    // Error text is forwarded to a channel that may be public (an
    // unauthenticated ntfy topic), so bound how much of it travels. Slice by
    // code point so a multibyte character is never split into a replacement.
    // Redact before the cut: a slice that ends between a password and its `@`
    // would leave the password with nothing left to recognise it by.
    const error = [...redactSecrets(r.error ?? '')].slice(0, 120).join('');
    lines.push(r.ok ? `✅ ${r.name}` : `❌ ${r.name}: ${error}`);
  }
  return lines.join('\n');
}
