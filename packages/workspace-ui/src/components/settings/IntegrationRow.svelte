<script lang="ts">
  /** One account on the Integrations page, drawn as an MCP catalog row: the
   *  logo on a tile, the name and one line, and the action at the trailing
   *  edge. A failure takes the place of the line, so the row keeps its height. */
  import type { Snippet } from "svelte";
  import Icon from "@iconify/svelte";
  import { Check } from "@lucide/svelte";

  interface Props {
    name: string;
    /** An Iconify name from `PROVIDER_LOGOS`. */
    logo: string;
    description: string;
    isConnected: boolean;
    error?: string | null;
    action: Snippet;
    testId?: string;
  }

  let { name, logo, description, isConnected, error = null, action, testId }: Props = $props();
</script>

<li class="flex min-w-0 items-center gap-3.5 py-3" data-testid={testId}>
  <span class="grid size-8 shrink-0 place-items-center rounded-lg border border-border/50 bg-white text-neutral-900 shadow-xs" aria-hidden="true">
    <Icon icon={logo} width={18} height={18} />
  </span>
  <div class="min-w-0 flex-1 pr-6">
    <p class="flex min-w-0 items-center gap-1.5 text-workspace-chrome leading-5 font-medium text-foreground">
      <span class="truncate">{name}</span>
      {#if isConnected}
        <Check size={14} strokeWidth={2.5} role="img" aria-label="{name} is connected" class="shrink-0 text-(--solus-status-complete)" />
      {/if}
    </p>
    {#if error}
      <p role="alert" class="truncate text-chrome-dense leading-5 text-(--solus-status-error)" title={error}>{error}</p>
    {:else}
      <p class="truncate text-chrome-dense leading-5 text-muted-foreground" title={description}>{description}</p>
    {/if}
  </div>
  <div class="flex shrink-0 items-center gap-1">{@render action()}</div>
</li>
