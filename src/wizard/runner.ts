import type { AppConfig } from '../config/schema.js';
import type { WizardStep, WizardContext } from './types.js';
import { stepHeader, editHeader, divider } from './ui.js';

function runsNow(step: WizardStep, ctx: WizardContext): boolean {
  return !step.shouldRun || step.shouldRun(ctx);
}

/**
 * Run each step once, in `order`. shouldRun() is asked when a step's turn
 * comes, not up front: filtering once before the first step dropped every step
 * that depends on an earlier answer, so in a fresh setup Garmin and Strava
 * authorization never ran even after both were configured.
 *
 * There is no Back here. Every step starts from what the config already holds,
 * so going back is picking the section again in the menu that follows
 * (runSectionMenu), which a fresh setup ends with too.
 */
export async function runWizard(
  steps: WizardStep[],
  ctx: WizardContext,
): Promise<Partial<AppConfig>> {
  const ordered = [...steps].sort((a, b) => a.order - b.order);

  for (const step of ordered) {
    if (!runsNow(step, ctx)) continue;
    // Counted afresh each time: the total changes as answers switch steps on or off.
    const active = ordered.filter((s) => runsNow(s, ctx));
    stepHeader(active.indexOf(step) + 1, active.length, step.title);
    await step.run(ctx);
  }

  return ctx.config;
}

export const SAVE_VALUE = '__save__';
export const QUIT_VALUE = '__quit__';

/**
 * The section menu: pick a section to run again, Review & Save, which runs
 * the summary step and ends once it saved, or Quit without saving. Edit mode
 * is this menu alone; a fresh setup shows it after the last step, in place of
 * the Back prompt it used to put before every step. Review & Save comes
 * first, so Enter finishes.
 *
 * A save that is declined or fails comes back here: the menu used to end
 * after the summary whatever it did, so a "No" at "Save anyway?" lost every
 * answer and the process still exited 0. Whether anything was saved is left
 * in ctx.saved.
 *
 * The menu is rebuilt after every section, so adding a Strava exporter offers
 * Strava authorization right away and removing the last one takes it away.
 */
export async function runSectionMenu(
  steps: WizardStep[],
  ctx: WizardContext,
  message = 'Which section do you want to edit?',
): Promise<Partial<AppConfig>> {
  for (;;) {
    const editableSteps = steps
      .filter((s) => runsNow(s, ctx))
      .filter((s) => s.id !== 'welcome' && s.id !== 'summary') // Welcome + Summary not in menu
      .sort((a, b) => a.order - b.order);

    divider();
    const choices = [
      { name: 'Review & Save', value: SAVE_VALUE },
      ...editableSteps.map((s) => ({ name: s.title, value: s.id })),
      { name: 'Quit without saving', value: QUIT_VALUE },
    ];

    const choice = await ctx.prompts.select(message, choices);

    if (choice === QUIT_VALUE) break;

    if (choice === SAVE_VALUE) {
      const summaryStep = steps.find((s) => s.id === 'summary');
      if (!summaryStep) break;
      editHeader(summaryStep.title);
      await summaryStep.run(ctx);
      if (ctx.saved) break;
      continue;
    }

    const step = editableSteps.find((s) => s.id === choice);
    if (step) {
      editHeader(step.title);
      await step.run(ctx);
    }
  }

  return ctx.config;
}

/** Edit mode: the section menu over an existing config. */
export function runEditMode(steps: WizardStep[], ctx: WizardContext): Promise<Partial<AppConfig>> {
  return runSectionMenu(steps, ctx);
}
