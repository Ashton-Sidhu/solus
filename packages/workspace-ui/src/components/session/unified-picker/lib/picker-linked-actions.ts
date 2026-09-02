import type { Task, TaskLink } from "@solus/contracts/task-types";
import { getWorkspaceContext } from "../../../../contexts";
import { linkedPrNavigationTarget } from "../../../tasks/task-page/lib/linked-pr-navigation";

type WorkspaceContext = ReturnType<typeof getWorkspaceContext>;

/** Open a task link on the same pane and host that the task page uses. */
export function openPickerLinkedItem(
  session: WorkspaceContext,
  task: Task,
  link: TaskLink,
): void {
  switch (link.kind) {
    case "work":
      void session.openWorkModal(
        link.targetKey,
        link.liveTitle || link.title,
        { secondary: true, via: "click" },
      );
      break;
    case "plan":
      void session.openPlanModal(
        `${link.targetScope}__${link.targetKey}`,
        undefined,
        { secondary: true },
      );
      break;
    case "automation":
      session.openAutomationBuilder(link.targetKey, "aside");
      break;
    case "pr": {
      const number = Number(link.targetKey);
      if (!Number.isFinite(number)) break;
      const taskStore = session.tasksStore.get(task.id);
      const target = linkedPrNavigationTarget({
        taskServerId: taskStore.serverId,
        taskProjectDirectory: task.projectKey,
        linkProjectDirectory: link.targetScope,
      });
      void session.openPullRequest(
        { number, title: link.title, url: link.url },
        {
          ctx: target.projectDirectory
            ? session.ctxForDirectory(target.projectDirectory)
            : session.ctx,
          serverId: target.serverId,
        },
      );
      break;
    }
  }
}
