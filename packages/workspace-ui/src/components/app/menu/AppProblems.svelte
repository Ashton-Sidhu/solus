<script lang="ts">
  import { CircleAlert as ErrorIcon, TriangleAlert as WarningIcon } from "@lucide/svelte";
  import { Button } from "../../ui/button";
  import type { AppMenuSection, AppProblem } from "../lib/app-view";

  /**
   * What the app's owner must act on (docs/plans/apps.md §9). The app surface
   * says none of it over the app; each row opens the section where the owner acts.
   */
  interface Props {
    problems: AppProblem[];
    onOpenSection: (section: AppMenuSection) => void;
  }
  let { problems, onOpenSection }: Props = $props();
</script>

{#if problems.length === 0}
  <p class="m-0 text-sm text-muted-foreground">This app has no problems.</p>
{:else}
  <ul class="m-0 flex list-none flex-col gap-2 p-0" data-testid="app-problems">
    {#each problems as problem (problem.kind + problem.detail)}
      <li class="flex min-w-0 flex-wrap items-start gap-x-2.5 gap-y-1.5 rounded-lg border border-border/50 px-3 py-2">
        {#if problem.tone === "error"}
          <ErrorIcon size={14} class="mt-0.5 shrink-0 text-destructive" aria-label="Error" />
        {:else}
          <WarningIcon size={14} class="mt-0.5 shrink-0 text-(--warning)" aria-label="Warning" />
        {/if}
        <span class="min-w-40 flex-1 text-sm text-pretty">{problem.detail}</span>
        <Button size="xs" variant="outline" onclick={() => onOpenSection(problem.section)}>{problem.action}</Button>
      </li>
    {/each}
  </ul>
{/if}
