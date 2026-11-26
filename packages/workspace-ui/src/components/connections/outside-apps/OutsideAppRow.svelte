<script lang="ts">
  /** One row of the directory: the app's logo, name, and line, and on the
   *  right what it stands at (`AppRowState`). The whole row opens and closes
   *  it in place; open, it shows `OutsideAppPanel`, and its Connect reads
   *  Cancel. */
  import { Check as CheckIcon, Plus as PlusIcon } from "@lucide/svelte";
  import type { OutsideAppGuide } from "@solus/contracts/outside-apps";
  import type { AppGrant, AppRowState } from "../lib/outside-apps-directory";
  import { outsideAppLogo } from "./outside-app-logos";
  import OutsideAppPanel from "./OutsideAppPanel.svelte";

  interface Props {
    serverId: string;
    hostName: string;
    /** Null for Another MCP app. */
    guide: OutsideAppGuide | null;
    name: string;
    line: string;
    state: AppRowState;
    /** Why the person's organization does not allow the app; null when it does. */
    denial: string | null;
    grants: readonly AppGrant[];
    onHostComputer: boolean;
    isOpen: boolean;
    onToggle: () => void;
  }

  let { serverId, hostName, guide, name, line, state, denial, grants, onHostComputer, isOpen, onToggle }: Props = $props();

  const logo = $derived(guide ? outsideAppLogo(guide.id) : null);
  const isConnected = $derived(state === "connected" || state === "cant-reach");
  const panelId = $derived(`outside-app-panel-${guide?.id ?? "other"}`);
</script>

<div class="border-b border-border last:border-b-0">
  <button
    type="button"
    aria-expanded={isOpen}
    aria-controls={isOpen ? panelId : undefined}
    disabled={state === "not-allowed"}
    title={denial ?? undefined}
    data-outside-app-row={guide?.id ?? "other"}
    onclick={onToggle}
    class="group flex w-full items-center gap-3.5 overflow-hidden rounded-lg py-3.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed"
  >
    {#if logo}
      <img
        src={logo.src}
        alt=""
        draggable="false"
        class={["size-11 shrink-0 rounded-[0.6875rem] object-cover ring-1 ring-black/8 dark:ring-white/12", logo.onDark && "bg-neutral-900 p-[0.5625rem]", state === "not-allowed" && "opacity-45"]}
      />
    {:else if guide}
      <span aria-hidden="true" class="flex size-11 shrink-0 items-center justify-center rounded-[0.6875rem] bg-muted text-base font-semibold text-(--solus-text-secondary) ring-1 ring-black/8 dark:ring-white/12">{name.slice(0, 1)}</span>
    {:else}
      <span aria-hidden="true" class="flex size-11 shrink-0 items-center justify-center rounded-[0.6875rem] border-[1.5px] border-dashed border-(--solus-text-tertiary)/45">
        <PlusIcon size={18} class="text-(--solus-text-secondary)" />
      </span>
    {/if}
    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class={["truncate text-[0.9375rem] leading-4.5 font-semibold", state === "not-allowed" ? "text-(--solus-text-tertiary)" : "text-(--solus-text-primary)"]}>{name}</span>
      <span class="truncate text-[0.8125rem] leading-4 text-(--solus-text-tertiary)">{line}</span>
    </span>
    <span class="flex shrink-0 items-center">
      {#if isOpen && !isConnected}
        <span class="rounded-full px-3.5 py-1.5 text-[0.8125rem] leading-4 font-medium text-(--solus-text-secondary) group-hover:bg-muted">Cancel</span>
      {:else if state === "connected"}
        <span class="flex items-center gap-1.5 px-1 py-1.5 text-[0.8125rem] leading-4 font-medium text-(--solus-status-complete)">
          <CheckIcon size={14} strokeWidth={3} />
          Connected
        </span>
      {:else if state === "cant-reach"}
        <span class="px-1 py-1.5 text-[0.8125rem] leading-4 font-medium text-(--solus-status-error)">Can’t reach Solus</span>
      {:else if state === "needs-address"}
        <span class="px-3.5 py-1.5 text-[0.8125rem] leading-4 font-medium text-(--solus-text-tertiary)">Needs address</span>
      {:else if state === "not-allowed"}
        <span class="px-3.5 py-1.5 text-[0.8125rem] leading-4 font-medium text-(--solus-text-tertiary)">Not allowed</span>
      {:else}
        <span class="rounded-full bg-muted px-3.5 py-1.5 text-[0.8125rem] leading-4 font-semibold text-(--solus-text-primary) transition-colors group-hover:bg-(--solus-surface-active)">{guide ? "Connect" : "Set up"}</span>
      {/if}
    </span>
  </button>
  {#if isOpen}
    <div id={panelId} class="pt-1 pb-5.5 pl-14.5">
      <OutsideAppPanel {serverId} {hostName} {guide} {grants} {onHostComputer} />
    </div>
  {/if}
</div>
