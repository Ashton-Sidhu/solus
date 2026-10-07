<script lang="ts">
  import { GitPullRequest } from "@lucide/svelte";
  import { prStatusBadge, REQUIRED_CHECKS_FAILING_BADGE } from "../prs/lib/pr-utils";
  import { taskPrMenuTitle } from "./lib/task-pr-menu";
  import type { TaskPrChoice } from "./lib/task-list";

  let { choice }: { choice: TaskPrChoice } = $props();
  const badge = $derived(
    choice.requiredChecksFail ? REQUIRED_CHECKS_FAILING_BADGE : prStatusBadge(choice.pullRequest),
  );
  const StateIcon = $derived(badge?.Icon ?? GitPullRequest);
</script>

<!-- One line per pull request keeps a list of several short. The icon's color
     carries the state; screen readers get it as text. -->
<span class="flex size-4 shrink-0 items-center justify-center" style:color={badge?.tone ?? "var(--muted-foreground)"} aria-hidden="true">
  <StateIcon size={14} />
</span>
<span class="min-w-0 flex-1 truncate text-foreground">{taskPrMenuTitle(choice)}</span>
{#if badge}
  <span class="sr-only">{badge.label}</span>
{/if}
<span class="shrink-0 tabular-nums text-muted-foreground">#{choice.number}</span>
