<script lang="ts">
  import { Pin as PushPinIcon } from "@lucide/svelte";
  import type { PinnedSession } from "@solus/contracts/types";
  import { groupKeyFor } from "../../contexts";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import * as TooltipUI from "../ui/tooltip";
  import SessionSidebarTooltip from "./SessionSidebarTooltip.svelte";

  /** A row of the sidebar's Pinned section. It has the slim shape of a
   *  shelved row: the project mark, the title, and Unpin on hover. */
  interface Props {
    pin: PinnedSession;
    /** Its conversation is the one on screen. */
    isCurrentSession: boolean;
    onOpen: () => void;
    onUnpin: () => void;
    onMore: (event: MouseEvent) => void;
  }
  let { pin, isCurrentSession, onOpen, onUnpin, onMore }: Props = $props();

  const groupKey = $derived(groupKeyFor(pin.serverId ?? "", pin.cwd));
</script>

<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props: tooltipProps })}
      <div
        {...tooltipProps}
        class="group/row relative -mx-2 flex h-[2.25rem] cursor-pointer items-center gap-[0.5625rem] rounded-lg pr-2 pl-[0.625rem] text-foreground transition-[background,color,box-shadow] duration-150 hover:bg-card hover:shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_10%,transparent),0_2px_6px_color-mix(in_oklch,var(--foreground)_8%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring dark:hover:bg-[color-mix(in_oklch,var(--card)_94%,white)] {isCurrentSession
          ? 'bg-card shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_10%,transparent),0_2px_6px_color-mix(in_oklch,var(--foreground)_8%,transparent)] dark:bg-[color-mix(in_oklch,var(--card)_94%,white)]'
          : ''}"
        role="treeitem"
        tabindex="0"
        aria-selected={isCurrentSession}
        aria-label={pin.title}
        onclick={onOpen}
        oncontextmenu={onMore}
        onkeydown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
      >
        <span class="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
          <ProjectFavicon projectKey={groupKey} class="size-4 pointer-fine:[&_.lucide-icon]:size-[82%]" />
        </span>
        <span
          class="min-w-0 flex-1 truncate text-workspace-chrome {isCurrentSession ? 'font-medium' : ''}"
          >{pin.title}</span
        >
        <button
          type="button"
          class="hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,background] duration-[120ms] group-hover/row:flex group-focus-within/row:flex hover:bg-accent hover:text-foreground pointer-coarse:flex"
          aria-label="Unpin session"
          title="Unpin"
          onclick={(event) => {
            event.stopPropagation();
            onUnpin();
          }}
        >
          <PushPinIcon size={14} class="fill-current" />
        </button>
      </div>
    {/snippet}
  </TooltipUI.Trigger>
  <SessionSidebarTooltip
    title={pin.title}
    projectKey={pin.cwd}
    {groupKey}
    serverId={pin.serverId}
    provider={pin.provider}
    modelId={pin.model}
  />
</TooltipUI.Root>
