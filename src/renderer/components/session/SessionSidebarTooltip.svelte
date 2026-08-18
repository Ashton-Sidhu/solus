<script lang="ts">
  import {
    GitBranchIcon,
    GlobeIcon,
    LaptopIcon,
  } from "phosphor-svelte";
  import type { AttentionState } from "../../lib/sessionUtils";
  import { attentionLabel } from "../../lib/sessionUtils";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import * as TooltipUI from "../ui/tooltip";

  interface Props {
    title: string;
    projectKey?: string;
    projectLabel?: string;
    branchName?: string | null;
    serverId?: string | null;
    attention?: AttentionState;
  }

  let {
    title,
    projectKey,
    projectLabel,
    branchName,
    serverId,
    attention,
  }: Props = $props();

  const host = $derived(serversStore.hostFor(serverId));
  const isRemote = $derived(!!host && !host.local);
  const resolvedProjectLabel = $derived(
    projectLabel ?? projectKey?.replace(/\/$/, "").split("/").at(-1),
  );
</script>

<TooltipUI.Content
  side="right"
  align="start"
  sideOffset={4}
  class="max-w-80 items-stretch whitespace-normal p-0 text-left font-normal"
>
  <div class="flex min-w-0 max-w-80 flex-col gap-2 p-2.5">
    <div class="min-w-0 truncate text-xs font-medium text-(--solus-text-primary)">
      {title}
    </div>
    <div class="grid gap-1.5 pl-0.5 text-xs text-(--solus-text-tertiary)">
      {#if resolvedProjectLabel}
        <div class="flex min-w-0 items-center gap-2">
          {#if projectKey?.startsWith("/")}
            <ProjectFavicon projectRoot={projectKey} class="size-3 shrink-0" />
          {:else}
            <LaptopIcon size={12} class="shrink-0" />
          {/if}
          <span class="min-w-0 truncate text-(--solus-text-secondary)">{resolvedProjectLabel}</span>
        </div>
      {/if}
      <div class="flex min-w-0 items-center gap-2">
        {#if isRemote}
          <GlobeIcon size={12} class="shrink-0" />
        {:else}
          <LaptopIcon size={12} class="shrink-0" />
        {/if}
        <span class="min-w-0 truncate text-(--solus-text-secondary)">
          {isRemote ? host?.label : "This machine"}
        </span>
      </div>
      {#if branchName}
        <div class="flex min-w-0 items-center gap-2">
          <GitBranchIcon size={12} class="shrink-0" />
          <span class="min-w-0 truncate text-(--solus-text-secondary)">{branchName}</span>
        </div>
      {/if}
      {#if attention}
        <div class="text-(--solus-text-secondary)">{attentionLabel(attention)}</div>
      {/if}
    </div>
  </div>
</TooltipUI.Content>
