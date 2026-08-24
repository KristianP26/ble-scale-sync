import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { ExportContext } from '../interfaces/exporter.js';
import { fmtWeight } from '../runtime/format.js';

/** Message body shared by the push notification exporters (ntfy, telegram). */
export function formatNotification(data: BodyComposition, context?: ExportContext): string {
  const unit = context?.weightUnit ?? 'kg';
  const prefix = context?.userName ? `[${context.userName}] ` : '';
  const lines = [
    `${prefix}⚖️ ${fmtWeight(data.weight, unit)} | BMI ${data.bmi.toFixed(1)}`,
    `🏋️ Body Fat ${data.bodyFatPercent.toFixed(1)}% | Muscle ${fmtWeight(data.muscleMass, unit)}`,
    `💧 Water ${data.waterPercent.toFixed(1)}% | 🦴 Bone ${fmtWeight(data.boneMass, unit)}`,
    `🫀 Visceral Fat ${data.visceralFat} | BMR ${data.bmr} kcal`,
    `📅 Metabolic Age ${data.metabolicAge} yr | Physique ${data.physiqueRating}`,
  ];
  if (context?.driftWarning) {
    lines.push(`⚠️ ${context.driftWarning}`);
  }
  for (const r of context?.exportResults ?? []) {
    // Error text is forwarded verbatim to a channel that may be public (an
    // unauthenticated ntfy topic), so bound how much of it travels. Slice by
    // code point so a multibyte character is never split into a replacement.
    const error = [...(r.error ?? '')].slice(0, 120).join('');
    lines.push(r.ok ? `✅ ${r.name}` : `❌ ${r.name}: ${error}`);
  }
  return lines.join('\n');
}
