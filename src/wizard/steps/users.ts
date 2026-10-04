import type { WizardStep, WizardContext } from '../types.js';
import { generateSlug, validateSlugUniqueness } from '../../config/slugify.js';
import type { UserConfig } from '../../config/schema.js';
import { success, warn, dim } from '../ui.js';

function validateDate(v: string): string | true {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'Must be YYYY-MM-DD format';
  const [y, m, d] = v.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return 'Invalid date';
  }
  if (date > new Date()) return 'Birth date cannot be in the future';
  return true;
}

function validatePositiveNumber(v: string): string | true {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 'Must be a positive number';
  return true;
}

const KG_PER_LB = 2.20462;

/**
 * Ask for one user's profile.
 *
 * `takenSlugs` are the slugs other users hold. With `existing`, every prompt
 * is pre-filled with that user's value and the result is merged into a copy
 * of it, so the keys this step never asks about (per-user `exporters`,
 * `last_known_weight`, the `beurer_*` keys) survive an edit.
 */
async function promptUser(
  ctx: WizardContext,
  takenSlugs: string[],
  existing?: UserConfig,
): Promise<UserConfig> {
  const { prompts, config } = ctx;

  const name = await prompts.input('User name:', {
    default: existing?.name,
    validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
  });

  // An existing user keeps their slug even when renamed: the slug names their
  // token directories and is how a reload finds them again.
  const autoSlug = existing?.slug ?? generateSlug(name, takenSlugs);
  if (!existing) console.log(`  ${dim(`Auto-generated slug: ${autoSlug}`)}`);

  const slug = await prompts.input('Slug (press Enter to accept):', {
    default: autoSlug,
    validate: (v) => {
      if (!/^[a-z0-9-]+$/.test(v)) {
        return 'Slug must contain only lowercase letters, numbers, and hyphens';
      }
      if (takenSlugs.includes(v)) {
        return `Slug '${v}' is already in use`;
      }
      return true;
    },
  });

  const weightUnit = config.scale?.weight_unit ?? 'kg';
  const heightUnit = config.scale?.height_unit ?? 'cm';

  const heightLabel = heightUnit === 'in' ? 'Height (inches):' : 'Height (cm):';
  const heightStr = await prompts.input(heightLabel, {
    default: existing ? String(existing.height) : undefined,
    validate: validatePositiveNumber,
  });
  const height = Number(heightStr);

  const birth_date = await prompts.input('Birth date (YYYY-MM-DD):', {
    default: existing?.birth_date,
    validate: validateDate,
  });

  // The prompt provider has no select default; the first choice is what Enter
  // picks, so the current gender goes first.
  const genderChoices: { name: string; value: 'male' | 'female' }[] = [
    { name: 'Male', value: 'male' },
    { name: 'Female', value: 'female' },
  ];
  if (existing?.gender === 'female') genderChoices.reverse();
  const gender = await prompts.select<'male' | 'female'>('Gender:', genderChoices);

  const is_athlete = await prompts.confirm('Athlete mode? (adjusts body composition formulas)', {
    default: existing?.is_athlete ?? false,
  });

  // Weight range, stored in kg, asked in the display unit
  const unitLabel = weightUnit === 'lbs' ? 'lbs' : 'kg';
  const shown = (kg: number): string =>
    weightUnit === 'lbs' ? String(Math.round(kg * KG_PER_LB * 10) / 10) : String(kg);
  const minDefault = existing ? shown(existing.weight_range.min) : undefined;
  const maxDefault = existing ? shown(existing.weight_range.max) : undefined;
  const minStr = await prompts.input(`Weight range minimum (${unitLabel}):`, {
    default: minDefault,
    validate: validatePositiveNumber,
  });
  const maxStr = await prompts.input(`Weight range maximum (${unitLabel}):`, {
    default: maxDefault,
    validate: (v) => {
      const result = validatePositiveNumber(v);
      if (result !== true) return result;
      if (Number(v) <= Number(minStr)) return 'Max must be greater than min';
      return true;
    },
  });

  // Convert lbs to kg for storage. A value accepted unchanged keeps the stored
  // kg exactly: converting the rounded lbs default back would drift it a
  // little on every edit.
  const toKg = (input: string, shownDefault: string | undefined, storedKg?: number): number => {
    if (storedKg !== undefined && input === shownDefault) return storedKg;
    const n = Number(input);
    return weightUnit === 'lbs' ? Math.round((n / KG_PER_LB) * 100) / 100 : n;
  };
  const min = toKg(minStr, minDefault, existing?.weight_range.min);
  const max = toKg(maxStr, maxDefault, existing?.weight_range.max);
  if (weightUnit === 'lbs') {
    console.log(dim(`  → stored as ${min}–${max} kg`));
  }

  const weight_range = { min, max };

  return {
    ...(existing ?? { last_known_weight: null }),
    name,
    slug,
    height,
    birth_date,
    gender,
    is_athlete,
    weight_range,
  };
}

type ExistingUserAction = 'keep' | 'edit' | 'remove';

export const usersStep: WizardStep = {
  id: 'users',
  title: 'User Profiles',
  order: 30,

  async run(ctx: WizardContext): Promise<void> {
    const users: UserConfig[] = [];
    const existingUsers = ctx.isEditMode ? [...((ctx.config.users as UserConfig[]) ?? [])] : [];

    // Edit mode used to rebuild every user from blank prompts and replace the
    // array, so fixing one height dropped every per-user exporter, the
    // last_known_weight anchor and the Beurer consent keys of all users.
    // Existing users are now kept, edited in place, or removed one by one.
    if (existingUsers.length > 0) {
      console.log('\nExisting user profiles:\n');
      for (let i = 0; i < existingUsers.length; i++) {
        const existing = existingUsers[i];
        const action = await ctx.prompts.select<ExistingUserAction>(
          `User "${existing.name}" (${existing.slug}):`,
          [
            { name: 'Keep unchanged', value: 'keep' },
            { name: 'Edit', value: 'edit' },
            { name: 'Remove', value: 'remove' },
          ],
        );
        if (action === 'remove') continue;
        if (action === 'keep') {
          users.push(existing);
          continue;
        }
        // Users not handled yet may still be kept, so their slugs are taken.
        const taken = [...users, ...existingUsers.slice(i + 1)].map((u) => u.slug);
        users.push(await promptUser(ctx, taken, existing));
      }
    }

    if (users.length === 0) {
      console.log('\nSet up user profiles (you can add multiple users):\n');
      // At least one user is required
      users.push(await promptUser(ctx, []));
    }

    // Additional users
    for (;;) {
      const addMore = await ctx.prompts.confirm('Add another user?', { default: false });
      if (!addMore) break;

      const user = await promptUser(
        ctx,
        users.map((u) => u.slug),
      );
      users.push(user);
    }

    // Validate slug uniqueness
    const slugs = users.map((u) => u.slug);
    const duplicates = validateSlugUniqueness(slugs);
    if (duplicates.length > 0) {
      console.log(`\n${warn(`Duplicate slugs detected: ${duplicates.join(', ')}`)}`);
    }

    ctx.config.users = users;

    console.log(
      `\n  ${success(`${users.length} user(s) configured: ${users.map((u) => u.name).join(', ')}`)}`,
    );
  },
};

// Exported for testing
export { validateDate, validatePositiveNumber, promptUser };
