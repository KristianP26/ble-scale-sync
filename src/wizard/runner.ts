import type { AppConfig } from '../config/schema.js';
import { BackNavigation } from './types.js';
import type { WizardStep, WizardContext } from './types.js';
import { stepHeader, editHeader, divider } from './ui.js';

function runsNow(step: WizardStep, ctx: WizardContext): boolean {
  return !step.shouldRun || step.shouldRun(ctx);
}

/**
 * Run the wizard in sequential mode.
 * Steps are sorted by order and executed sequentially; shouldRun() is asked
 * when a step's turn comes, not up front. Supports back navigation via the
 * BackNavigation sentinel.
 *
 * Filtering once before the first step dropped every step that depends on an
 * earlier answer: in a fresh setup there are no users or exporters yet, so
 * Garmin and Strava authorization never ran even after both were configured.
 */
export async function runWizard(
  steps: WizardStep[],
  ctx: WizardContext,
): Promise<Partial<AppConfig>> {
  const ordered = [...steps].sort((a, b) => a.order - b.order);

  /** The first step at or after `from` that runs now, or ordered.length. */
  const nextFrom = (from: number): number => {
    let j = from;
    while (j < ordered.length && !runsNow(ordered[j], ctx)) j++;
    return j;
  };
  /** The last step before `from` that runs now, or -1. */
  const prevBefore = (from: number): number => {
    let j = from - 1;
    while (j >= 0 && !runsNow(ordered[j], ctx)) j--;
    return j;
  };

  let i = nextFrom(0);
  while (i < ordered.length) {
    const step = ordered[i];
    // Counted afresh each time: the total changes as answers switch steps on or off.
    const active = ordered.filter((s) => runsNow(s, ctx));
    stepHeader(active.indexOf(step) + 1, active.length, step.title);

    // Offer back navigation for non-first steps
    const prev = prevBefore(i);
    if (prev >= 0) {
      const action = await ctx.prompts.select(`${step.title}:`, [
        { name: 'Continue', value: 'continue' },
        { name: '\u2190 Back', value: 'back' },
      ]);
      if (action === 'back') {
        ctx.stepHistory.pop();
        i = prev;
        continue;
      }
    }

    try {
      await step.run(ctx);
      ctx.stepHistory.push(step.id);
      i = nextFrom(i + 1);
    } catch (err) {
      if (err instanceof BackNavigation) {
        // Asked again: the step may have changed what runs before giving up.
        const back = prevBefore(i);
        if (back >= 0) {
          // Pop the previous step from history and go back
          ctx.stepHistory.pop();
          i = back;
        }
        // With no earlier step, stay at this one
      } else {
        throw err;
      }
    }
  }

  return ctx.config;
}

/**
 * Run the wizard in edit mode.
 * Shows a menu of steps; user picks which to re-run, then "Review & Save" exits.
 * The menu is rebuilt after every section, so adding a Strava exporter offers
 * Strava authorization right away and removing the last one takes it away.
 */
export async function runEditMode(
  steps: WizardStep[],
  ctx: WizardContext,
): Promise<Partial<AppConfig>> {
  const SAVE_VALUE = '__save__';

  for (;;) {
    const editableSteps = steps
      .filter((s) => runsNow(s, ctx))
      .filter((s) => s.id !== 'welcome' && s.id !== 'summary') // Welcome + Summary not in menu
      .sort((a, b) => a.order - b.order);

    divider();
    const choices = [
      ...editableSteps.map((s) => ({ name: s.title, value: s.id })),
      { name: 'Review & Save', value: SAVE_VALUE },
    ];

    const choice = await ctx.prompts.select('Which section do you want to edit?', choices);

    if (choice === SAVE_VALUE) {
      const summaryStep = steps.find((s) => s.id === 'summary');
      if (summaryStep) {
        editHeader(summaryStep.title);
        await summaryStep.run(ctx);
      }
      break;
    }

    const step = editableSteps.find((s) => s.id === choice);
    if (step) {
      editHeader(step.title);
      await step.run(ctx);
    }
  }

  return ctx.config;
}
