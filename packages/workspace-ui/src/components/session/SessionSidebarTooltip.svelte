<script lang="ts">
  import { GitBranch as GitBranchIcon, Laptop as LaptopIcon } from "@lucide/svelte";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import type { AttentionState } from "../../lib/sessionUtils";
  import { attentionLabel } from "../../lib/sessionUtils";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import ReviewGuideGlyph from "../review/ReviewGuideGlyph.svelte";
  import * as TooltipUI from "../ui/tooltip";
  import type { ReviewGuideIndicatorStatus } from "./lib/task-list";

  interface Props {
    title: string;
    projectKey?: string;
    projectLabel?: string;
    branchName?: string | null;
    serverId?: string | null;
    attention?: AttentionState;
    reviewGuideStatus?: ReviewGuideIndicatorStatus;
  }

  let {
    title,
    projectKey,
    projectLabel,
    branchName,
    serverId,
    attention,
    reviewGuideStatus,
  }: Props = $props();

  const host = $derived(serversStore.hostFor(serverId));
  const isRemote = $derived(!!host && !host.local);
  // A host Solus no longer has a saved entry for names no operating system;
  // the icon falls back to a globe in that case.
  const remoteOs = $derived(host && "os" in host ? host.os : undefined);
  const resolvedProjectLabel = $derived(
    projectLabel ?? projectKey?.replace(/\/$/, "").split("/").at(-1),
  );
</script>

<TooltipUI.Content
  side="right"
  align="start"
  sideOffset={4}
  class="items-stretch whitespace-normal p-0 text-left font-normal [.is-laptop-display_&]:max-w-80"
>
  <div class="flex min-w-0 max-w-96 flex-col gap-2 p-3 [.is-laptop-display_&]:max-w-80 [.is-laptop-display_&]:p-2.5">
    <div class="min-w-0 truncate text-workspace-chrome font-medium text-(--solus-text-primary)">
      {title}
    </div>
    <div class="grid gap-1.5 pl-0.5 text-workspace-chrome text-(--solus-text-tertiary)">
      {#if resolvedProjectLabel}
        <div class="flex min-w-0 items-center gap-2">
          {#if projectKey?.startsWith("/")}
            <ProjectFavicon
              projectRoot={projectKey}
              class="size-3.5 shrink-0 [.is-laptop-display_&]:size-3"
            />
          {:else}
            <LaptopIcon class="size-3.5 shrink-0 [.is-laptop-display_&]:size-3" />
          {/if}
          <span class="min-w-0 truncate text-(--solus-text-secondary)">{resolvedProjectLabel}</span>
        </div>
      {/if}
      <div class="flex min-w-0 items-center gap-2">
        {#if isRemote}
          <HostOperatingSystemIcon
            os={remoteOs}
            class="size-3.5 shrink-0 [.is-laptop-display_&]:size-3"
          />
        {:else}
          <LaptopIcon class="size-3.5 shrink-0 [.is-laptop-display_&]:size-3" />
        {/if}
        <span class="min-w-0 truncate text-(--solus-text-secondary)">
          {isRemote ? host?.label : "Local"}
        </span>
      </div>
      {#if branchName}
        <div class="flex min-w-0 items-center gap-2">
          <GitBranchIcon class="size-3.5 shrink-0 [.is-laptop-display_&]:size-3" />
          <span class="min-w-0 truncate text-(--solus-text-secondary)">{branchName}</span>
        </div>
      {/if}
      {#if attention}
        <div class="text-(--solus-text-secondary)">{attentionLabel(attention)}</div>
      {/if}
      {#if reviewGuideStatus}
        <div
          class="flex min-w-0 items-center gap-2 {reviewGuideStatus === 'ready'
            ? 'text-(--solus-art-positive)'
            : 'text-(--solus-status-running-icon)'}"
        >
          <ReviewGuideGlyph
            weight={reviewGuideStatus === "ready" ? "fill" : "regular"}
            class="size-3.5 shrink-0 [.is-laptop-display_&]:size-3"
          />
          <span>
            {reviewGuideStatus === "ready"
              ? "Review guide ready"
              : "Review guide loading"}
          </span>
        </div>
      {/if}
    </div>
  </div>
</TooltipUI.Content>
