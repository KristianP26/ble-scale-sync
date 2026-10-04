import type { WizardStep, WizardContext, PromptChoice } from '../types.js';
import type { ScaleConfig, UserConfig } from '../../config/schema.js';
import { resolveEnvReferences } from '../../config/env-refs.js';
import { dim, info, warn } from '../ui.js';

type WeightUnit = ScaleConfig['weight_unit'];
type HeightUnit = ScaleConfig['height_unit'];

const CM_PER_INCH = 2.54;

const WHOLE_REF = /^\$\{([^}]+)}$/;

const HEIGHT_UNIT_NAMES: Record<HeightUnit, string> = { cm: 'centimetres', in: 'inches' };

/** The provider has no select default; Enter picks the first choice, so the current one goes first. */
function currentFirst<T>(choices: PromptChoice<T>[], current: T | undefined): PromptChoice<T>[] {
  const at = choices.findIndex((c) => c.value === current);
  if (at > 0) choices.unshift(...choices.splice(at, 1));
  return choices;
}

/**
 * Inches to two decimals, centimetres to one. One decimal of an inch is
 * 2.5 mm, so a round trip drifted: 180 cm -> 70.9 in -> 180.1 cm.
 */
function convertHeight(height: number, from: HeightUnit, to: HeightUnit): number {
  if (from === to) return height;
  if (to === 'in') return Math.round((height / CM_PER_INCH) * 100) / 100;
  return Math.round(height * CM_PER_INCH * 10) / 10;
}

/** A `${VAR}` value resolved from the environment, or undefined when it does not resolve. */
function resolveRef(raw: string): string | undefined {
  try {
    return resolveEnvReferences(raw);
  } catch {
    return undefined;
  }
}

/**
 * The unit a scale.*_unit value means at run time. The value can be a `${VAR}`
 * reference, which config loading resolves from the environment; read as a
 * literal it looked like an unknown unit, so Enter replaced the reference and
 * converted every height. undefined when the value is not a unit at all.
 */
function effectiveUnit<T extends string>(
  raw: unknown,
  units: readonly T[],
  fallback: T,
): T | undefined {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string') return undefined;
  const resolved = resolveRef(raw);
  return units.find((u) => u === resolved);
}

/** What a `${VAR}` value stands for, for the warnings. */
function describeRaw(raw: unknown): string {
  return typeof raw === 'string' ? `'${raw}'` : String(raw);
}

export const unitsStep: WizardStep = {
  id: 'units',
  title: 'Units',
  order: 25,

  async run(ctx: WizardContext): Promise<void> {
    // The wizard never asked this, so every new config was kg/cm and anyone
    // using pounds or inches had to edit the file by hand.
    const current: Partial<ScaleConfig> = ctx.config.scale ?? {};
    const rawWeight: unknown = current.weight_unit;
    const rawHeight: unknown = current.height_unit;
    const oldWeight = effectiveUnit<WeightUnit>(rawWeight, ['kg', 'lbs'], 'kg');
    const oldHeight = effectiveUnit<HeightUnit>(rawHeight, ['cm', 'in'], 'cm');

    if (oldWeight === undefined) {
      console.log(
        `  ${warn(`scale.weight_unit is ${describeRaw(rawWeight)}, which is not kg or lbs.`)}`,
      );
    }
    if (oldHeight === undefined) {
      console.log(
        `  ${warn(
          `scale.height_unit is ${describeRaw(rawHeight)}, which is not cm or in. ` +
            'Heights are not converted; check them in the users section.',
        )}`,
      );
    }

    const weight_unit = await ctx.prompts.select<WeightUnit>(
      'Weight unit:',
      currentFirst<WeightUnit>(
        [
          { name: 'Kilograms (kg)', value: 'kg' },
          { name: 'Pounds (lbs)', value: 'lbs' },
        ],
        oldWeight,
      ),
    );

    const height_unit = await ctx.prompts.select<HeightUnit>(
      'Height unit:',
      currentFirst<HeightUnit>(
        [
          { name: 'Centimetres (cm)', value: 'cm' },
          { name: 'Inches (in)', value: 'in' },
        ],
        oldHeight,
      ),
    );

    // A height is stored in height_unit (resolveUserProfile converts inches),
    // so switching the unit without converting would turn 180 cm into 180 in.
    // weight_range is always kg and needs nothing. From an unknown unit there
    // is nothing to convert from, so the heights stay as they are (warned above).
    if (oldHeight !== undefined && height_unit !== oldHeight) {
      for (const u of (ctx.config.users ?? []) as UserConfig[]) {
        const raw: unknown = u.height;
        if (typeof raw === 'number') {
          u.height = convertHeight(raw, oldHeight, height_unit);
          console.log(
            `  ${info(`${u.name}: height ${raw} ${oldHeight} -> ${u.height} ${height_unit}`)}`,
          );
          continue;
        }
        // A ${VAR} height lives in .env, which the wizard does not write. Left
        // alone it would be read in the new unit: 180 cm becomes 180 in.
        const resolved = typeof raw === 'string' ? Number(resolveRef(raw)) : NaN;
        const varName = typeof raw === 'string' ? WHOLE_REF.exec(raw)?.[1] : undefined;
        const converted = convertHeight(resolved, oldHeight, height_unit);
        const newValue = Number.isFinite(resolved)
          ? ` Set ${varName ?? 'it'} to ${converted} in .env (it is ${resolved} ${oldHeight} now).`
          : '';
        console.log(
          `  ${warn(
            `${u.name}: height is ${describeRaw(raw)}, which the wizard cannot convert. ` +
              `Its value must now be in ${HEIGHT_UNIT_NAMES[height_unit]}.${newValue}`,
          )}`,
        );
      }
    }

    // A reference that means the chosen unit stays a reference.
    const keep = <T>(raw: unknown, old: T | undefined, chosen: T): T =>
      typeof raw === 'string' && old === chosen ? (raw as T) : chosen;

    ctx.config.scale = {
      ...current,
      weight_unit: keep(rawWeight, oldWeight, weight_unit),
      height_unit: keep(rawHeight, oldHeight, height_unit),
      display_unit: current.display_unit ?? 'weight_unit',
    };

    console.log(dim(`\n  Weight in ${weight_unit}, height in ${height_unit}.`));
  },
};

// Exported for testing
export { convertHeight };
