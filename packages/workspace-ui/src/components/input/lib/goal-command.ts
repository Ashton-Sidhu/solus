import { getWorkspaceContext } from "../../../contexts";

interface GoalCommandOptions {
  isReadOnly: () => boolean;
  targetTabId: () => string | undefined;
  sendPrompt: (text: string) => boolean;
  clearComposer: () => void;
  refocusComposer: () => void;
}

/** Runs goal commands against the conversation addressed by this composer. */
export function createGoalCommand(options: GoalCommandOptions) {
  const session = getWorkspaceContext();
  const router = session.router;
  async function handleGoalCommand(argument: string) {
    if (options.isReadOnly()) return;
    const goalTabId = options.targetTabId();
    const normalized = argument.trim();
    // A goal belongs to a thread, and a draft has none yet. Its objective goes
    // out as the first prompt instead; the session that starts inherits it the
    // same way a started-but-idle tab's does.
    if (!goalTabId) {
      if (normalized) options.sendPrompt(normalized);
      return;
    }
    const goalSession = session.sessionFor(goalTabId);
    // A goal belongs to the thread, not to the tab showing it.
    const goalSessionId = goalSession?.id ?? "";
    const isCodexGoal = goalSession?.run.provider === "codex";

    if (!normalized) {
      options.clearComposer();
      await session.refreshThreadGoal(goalSessionId);
      if (session.sessionFor(goalTabId)?.goal) {
        session.revealGoal(goalTabId);
      } else {
        session.addSystemMessage(
          "No goal is defined for this session yet.",
          goalTabId,
        );
      }
      options.refocusComposer();
      return;
    }

    if (!goalSession?.agentSessionId) {
      if (
        normalized === "clear" ||
        normalized === "pause" ||
        normalized === "resume" ||
        normalized === "edit" ||
        normalized.startsWith("edit ")
      ) {
        options.clearComposer();
        session.addSystemMessage(
          isCodexGoal
            ? "Define a goal before changing it."
            : "Goal changes are only supported for Codex sessions.",
          goalTabId,
        );
        options.refocusComposer();
        return;
      }
      if (normalized.length > 4000) {
        session.addSystemMessage(
          "Goal objectives must be 4,000 characters or fewer.",
          goalTabId,
        );
        options.refocusComposer();
        return;
      }
      if (goalSession) goalSession.pendingGoalObjective = normalized;
      options.sendPrompt(normalized);
      return;
    }

    try {
      if (!isCodexGoal) await session.refreshThreadGoal(goalSessionId);
      if (normalized === "clear") {
        if (!isCodexGoal) {
          options.clearComposer();
          session.addSystemMessage(
            "Clearing goals is only supported for Codex sessions.",
            goalTabId,
          );
          options.refocusComposer();
          return;
        }
        options.clearComposer();
        await session.clearThreadGoal(goalSessionId);
        if (router.params("goal")?.sessionId === goalSessionId) {
          router.close("goal");
        }
      } else if (normalized === "pause" || normalized === "resume") {
        if (!isCodexGoal) {
          options.clearComposer();
          session.addSystemMessage(
            "Pausing goals is only supported for Codex sessions.",
            goalTabId,
          );
          options.refocusComposer();
          return;
        }
        options.clearComposer();
        await session.setThreadGoal(goalSessionId, {
          status: normalized === "pause" ? "paused" : "active",
        });
        session.revealGoal(goalTabId);
      } else if (normalized === "edit") {
        if (!isCodexGoal) {
          options.clearComposer();
          session.addSystemMessage(
            "Editing goals is only supported for Codex sessions.",
            goalTabId,
          );
          options.refocusComposer();
          return;
        }
        options.clearComposer();
        await session.refreshThreadGoal(goalSessionId);
        if (goalSession.goal) session.revealGoal(goalTabId);
      } else {
        if (!isCodexGoal && normalized.startsWith("edit ")) {
          options.clearComposer();
          session.addSystemMessage(
            "Editing goals is only supported for Codex sessions.",
            goalTabId,
          );
          options.refocusComposer();
          return;
        }
        const objective = normalized.startsWith("edit ")
          ? normalized.slice(5).trim()
          : normalized;
        if (!objective || objective.length > 4000) {
          session.addSystemMessage(
            "Goal objectives must be between 1 and 4,000 characters.",
            goalTabId,
          );
          options.refocusComposer();
          return;
        }
        const currentGoal = session.sessionFor(goalTabId)?.goal;
        if (!isCodexGoal && currentGoal) {
          options.clearComposer();
          session.addSystemMessage(
            "Editing goals is only supported for Codex sessions.",
            goalTabId,
          );
          options.refocusComposer();
          return;
        }
        if (currentGoal)
          await session.setThreadGoal(goalSessionId, {
            objective,
            status: "active",
          });
        else await session.createThreadGoal(goalSessionId, objective);
        session.revealGoal(goalTabId);
        if (!normalized.startsWith("edit ")) options.sendPrompt(objective);
        else options.clearComposer();
      }
    } catch (error) {
      session.addSystemMessage(
        `Couldn't update goal: ${error instanceof Error ? error.message : String(error)}`,
        goalTabId,
      );
    }
    options.refocusComposer();
  }

  return handleGoalCommand;
}
