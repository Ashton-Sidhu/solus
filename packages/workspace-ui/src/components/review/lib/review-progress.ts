import {
  REVIEW_PROGRESS_STEPS,
  type ReviewProgressStep,
  type ReviewProgressStepDef,
} from "@solus/contracts/review";

/** What a review generation screen is making. The guide and the lens run the
 *  same three host steps, so they share one progress screen and differ only in
 *  their words and glyph. */
export type ReviewProgressSubject = "guide" | "lens";

export const LENS_PROGRESS_STEPS: ReviewProgressStepDef[] = [
  { id: "preparing", label: "Preparing the diff" },
  { id: "analyzing", label: "Reading the change" },
  { id: "writing", label: "Writing the lens" },
];

interface ReviewProgressCopy {
  steps: ReviewProgressStepDef[];
  queuedTitle: string;
  queuedDescription: string;
  description: string;
}

export const REVIEW_PROGRESS_COPY = {
  guide: {
    steps: REVIEW_PROGRESS_STEPS,
    queuedTitle: "Guide queued",
    queuedDescription: "Generation starts when the review companion is available.",
    description: "The review companion reads the diff and writes the guide.",
  },
  lens: {
    steps: LENS_PROGRESS_STEPS,
    queuedTitle: "Lens queued",
    queuedDescription: "The lens starts when the review companion is available.",
    description: "The review companion reads the change and draws your lens.",
  },
} satisfies Record<ReviewProgressSubject, ReviewProgressCopy>;

export function progressStepIndex(steps: readonly ReviewProgressStepDef[], step: ReviewProgressStep | undefined): number {
  return Math.max(0, steps.findIndex((s) => s.id === step));
}

/** How much of the ring is filled, 0 to 1. The active step counts as half
 *  done, so the ring moves on every step and is never full while a step still
 *  runs. A queued job has not started. */
export function progressFraction(activeIndex: number, total: number, queued: boolean): number {
  if (queued || total === 0) return 0;
  return Math.min(1, (activeIndex + 0.5) / total);
}
