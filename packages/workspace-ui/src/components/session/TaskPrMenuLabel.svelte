<script lang="ts">
  import { GitPullRequest } from "@lucide/svelte";
  import { prStatusBadge } from "../prs/lib/pr-utils";
  import { taskPrMenuTitle } from "./lib/task-pr-menu";
  import type { TaskPrChoice } from "./lib/task-list";

  let { choice }: { choice: TaskPrChoice } = $props();
  const badge = $derived(prStatusBadge(choice.pullRequest));
  const StateIcon = $derived(badge?.Icon ?? GitPullRequest);
</script>

<span class="flex size-4 shrink-0 items-center justify-center" style:color={badge?.tone ?? "var(--muted-foreground)"} aria-hidden="true">
  <StateIcon size={14} />
</span>
<span class="flex min-w-0 flex-1 flex-col gap-0.5 text-workspace-chrome">
  <span class="truncate font-medium text-foreground">{taskPrMenuTitle(choice)}</span>
  <span class="flex min-w-0 items-center gap-1.5 text-muted-foreground">
    <span class="shrink-0 tabular-nums">#{choice.number}</span>
    {#if badge}
      <span aria-hidden="true">·</span>
      <span class="truncate">{badge.label}</span>
    {/if}
  </span>
</span>
