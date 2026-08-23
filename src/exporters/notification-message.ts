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
  return lines.join('\n');
}
