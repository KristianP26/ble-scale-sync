import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { ExportContext } from '../interfaces/exporter.js';
import { fmtWeight } from '../runtime/format.js';
import { redactSecrets } from '../utils/error.js';

/** Message body shared by the push notification exporters (ntfy, telegram). */
export function formatNotification(data: BodyComposition, context?: ExportContext): string {
  const unit = context?.weightUnit ?? 'kg';
  const prefix = context?.userName ? `[${context.userName}] ` : '';
  // Only a scale that measured it sends a skeletal muscle percentage (#497).
  const skeletal =
    data.skeletalMusclePercent !== undefined
      ? ` | Skeletal ${data.skeletalMusclePercent.toFixed(1)}%`
      : '';
  const lines = [
    `${prefix}⚖️ ${fmtWeight(data.weight, unit)} | BMI ${data.bmi.toFixed(1)}`,
    `🏋️ Body Fat ${data.bodyFatPercent.toFixed(1)}% | Muscle ${fmtWeight(data.muscleMass, unit)}${skeletal}`,
    `💧 Water ${data.waterPercent.toFixed(1)}% | 🦴 Bone ${fmtWeight(data.boneMass, unit)}`,
    `🫀 Visceral Fat ${data.visceralFat} | BMR ${data.bmr} kcal`,
    `📅 Metabolic Age ${data.metabolicAge} yr | Physique ${data.physiqueRating}`,
  ];
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
