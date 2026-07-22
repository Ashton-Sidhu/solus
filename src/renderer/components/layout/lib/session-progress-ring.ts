import type {
  SessionProgress,
  SessionStatus,
  TodoItem,
} from "../../../../shared/types";

const MAX_SEGMENTED_STEPS = 10;
const SEGMENT_GAP = 2.5;

export type SessionProgressRingSegment = {
  start: number;
  length: number;
  state: TodoItem["status"];
};

export type SessionProgressRingModel = {
  mode: "segmented" | "continuous";
  segments: SessionProgressRingSegment[];
  label: string;
};

export function shouldShowSessionProgressRing(
  progress: SessionProgress | null | undefined,
  status: SessionStatus,
  isActive: boolean,
): boolean {
  return (
    !isActive &&
    (status === "running" || status === "connecting") &&
    !!progress?.todos.length
  );
}

export function buildSessionProgressRing(
  progress: SessionProgress,
): SessionProgressRingModel {
  const totalSteps = progress.todos.length;
  const completedCount = progress.todos.filter(
    (todo) => todo.status === "completed",
  ).length;
  const explicitRunningSteps = progress.todos.filter(
    (todo) => todo.status === "in_progress",
  );
  const fallbackRunningIndex =
    explicitRunningSteps.length === 0
      ? progress.todos.findIndex((todo) => todo.status === "pending")
      : -1;
  const runningStep =
    explicitRunningSteps[0] ?? progress.todos[fallbackRunningIndex];
  const label = runningStep
    ? `${completedCount} of ${totalSteps} steps complete · Running: ${runningStep.content}`
    : `${completedCount} of ${totalSteps} steps complete`;

  if (totalSteps <= MAX_SEGMENTED_STEPS) {
    const segmentLength = (100 - totalSteps * SEGMENT_GAP) / totalSteps;
    return {
      mode: "segmented",
      label,
      segments: progress.todos.map((todo, index) => ({
        start: index * (segmentLength + SEGMENT_GAP),
        length: segmentLength,
        state:
          index === fallbackRunningIndex ? "in_progress" : todo.status,
      })),
    };
  }

  const stepLength = 100 / totalSteps;
  const runningCount =
    explicitRunningSteps.length || (fallbackRunningIndex >= 0 ? 1 : 0);
  const segments: SessionProgressRingSegment[] = [
    { start: 0, length: 100, state: "pending" },
  ];
  if (completedCount > 0) {
    segments.push({
      start: 0,
      length: completedCount * stepLength,
      state: "completed",
    });
  }
  if (runningCount > 0) {
    segments.push({
      start: completedCount * stepLength,
      length: runningCount * stepLength,
      state: "in_progress",
    });
  }

  return { mode: "continuous", label, segments };
}
