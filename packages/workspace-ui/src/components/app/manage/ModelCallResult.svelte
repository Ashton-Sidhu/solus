<script lang="ts">
  import type { Snippet } from "svelte";
  import type { AppModelCallView } from "@solus/contracts/app-models";
  import { modelResultTree, type ResultNode } from "@solus/client-core/model-result";
  import { Button } from "../../ui/button";
  import CopyButton from "../../ui/CopyButton.svelte";
  import { modelCallResultText } from "./lib/model-calls";

  /**
   * What a model call returned to the app (docs/plans/app-models.md §7): its
   * fields laid out to read, or the JSON as it is. Copy gives the JSON.
   */
  interface Props {
    result: NonNullable<AppModelCallView["result"]>;
    /** The section's name, drawn beside the controls. */
    heading: Snippet;
  }
  let { result, heading }: Props = $props();

  let showsJson = $state(false);
  const tree = $derived(modelResultTree(result));
  const json = $derived(modelCallResultText(result));
  const isData = $derived(tree.kind !== "text" && tree.kind !== "short");
</script>

{#snippet node(value: ResultNode)}
  {#if value.kind === "text"}
    <p class="m-0 text-sm/relaxed whitespace-pre-wrap text-pretty text-foreground">{value.text}</p>
  {:else if value.kind === "short"}
    <p class="m-0 text-sm text-foreground">{value.text}</p>
  {:else if value.kind === "tags"}
    <ul class="m-0 flex list-none flex-wrap gap-x-1.5 gap-y-0.5 p-0 text-sm text-foreground">
      {#each value.items as item, index (index)}
        <li class="not-last:after:text-muted-foreground not-last:after:content-[',']">{item}</li>
      {/each}
    </ul>
  {:else if value.kind === "items"}
    <ol class="m-0 flex list-none flex-col gap-2 p-0">
      {#each value.items as item, index (index)}
        <li class="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2 border-b border-border/50 py-2.5 last:border-b-0">
          <span class="pt-px text-xs tabular-nums text-muted-foreground">{index + 1}</span>
          <div class="min-w-0">{@render node(item)}</div>
        </li>
      {/each}
    </ol>
  {:else if value.kind === "record"}
    <div class="flex min-w-0 flex-col gap-3">
      {#if value.title || value.facts.length > 0}
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          {#if value.title}
            <h5 class="m-0 min-w-0 text-sm font-medium text-foreground text-pretty">{value.title}</h5>
          {/if}
          {#if value.facts.length > 0}
            <dl class="m-0 flex flex-wrap gap-x-3 gap-y-1 text-xs">
              {#each value.facts as fact (fact.label)}
                <div class="flex gap-1"><dt class="text-muted-foreground">{fact.label}</dt><dd class="m-0 font-medium text-foreground">{fact.text}</dd></div>
              {/each}
            </dl>
          {/if}
        </div>
      {/if}
      {#each value.fields as field (field.label)}
        <section class="flex min-w-0 flex-col gap-1" aria-label={field.label}>
          <h6 class="m-0 text-xs font-medium text-muted-foreground">{field.label}</h6>
          {@render node(field.node)}
        </section>
      {/each}
    </div>
  {:else}
    <pre class="m-0 max-h-60 overflow-auto font-mono text-xs whitespace-pre">{value.text}</pre>
  {/if}
{/snippet}

<div class="flex min-w-0 flex-col gap-2" data-testid="app-model-call-result">
  <div class="flex min-w-0 items-center gap-1">
    <div class="min-w-0 flex-1">{@render heading()}</div>
    {#if isData}
      <Button size="xs" variant="ghost" class="text-muted-foreground" aria-pressed={showsJson} onclick={() => (showsJson = !showsJson)}>
        {showsJson ? "Show fields" : "Show JSON"}
      </Button>
    {/if}
    <CopyButton text={json} title="Copy the result" iconOnly refocusInput={false} />
  </div>
  {#if showsJson}
    <pre class="m-0 max-h-[28rem] overflow-auto font-mono text-xs whitespace-pre">{json}</pre>
  {:else}
    {@render node(tree)}
  {/if}
</div>
