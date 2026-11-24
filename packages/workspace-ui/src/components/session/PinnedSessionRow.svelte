<script lang="ts">
  import { Workflow as AutomationIcon } from "@lucide/svelte";
  import SessionPinButton from "./SessionPinButton.svelte";
  import type { PinnedSession } from "@solus/contracts/types";
  import { groupKeyFor } from "../../contexts";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import * as TooltipUI from "../ui/tooltip";
  import SessionRowHost from "./SessionRowHost.svelte";
  import SessionSidebarTooltip from "./SessionSidebarTooltip.svelte";

  /** A pinned session with no open conversation. It has the slim shape of a
   *  shelved row: the project mark, the title, and Unpin on hover. */
  interface Props {
    pin: PinnedSession;
    isAutomation: boolean;
    isGuest?: boolean;
    automationName?: string;
    /** Its conversation is the one on screen. */
    isCurrentSession: boolean;
    onOpen: () => void;
    onUnpin: () => void;
    onMore: (event: MouseEvent) => void;
  }
  let { pin, isAutomation, isGuest = false, automationName, isCurrentSession, onOpen, onUnpin, onMore }: Props = $props();

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
        aria-label={isAutomation ? `${automationName ?? pin.title}, automation` : pin.title}
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
        <SessionPinButton isPinned onToggle={onUnpin} />
        <span class="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
          <ProjectFavicon projectKey={groupKey} class="size-4 pointer-fine:[&_.lucide-icon]:size-[82%]" />
        </span>
        {#if isAutomation}
          <AutomationIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        {/if}
        <span
          class="min-w-0 flex-1 truncate text-workspace-chrome {isCurrentSession ? 'font-medium' : ''}"
          >{automationName ?? pin.title}</span
        >
        {#if !isGuest}<SessionRowHost serverId={pin.serverId} />{/if}
      </div>
    {/snippet}
  </TooltipUI.Trigger>
  <SessionSidebarTooltip
    title={pin.title}
    {isGuest}
    projectKey={pin.cwd}
    {groupKey}
    serverId={pin.serverId}
    provider={pin.provider}
    modelId={pin.model}
  />
</TooltipUI.Root>
