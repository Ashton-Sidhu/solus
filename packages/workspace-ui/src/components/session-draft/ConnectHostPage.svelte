<script lang="ts">
  import {
    ChevronRight as ChevronIcon,
    Cloud as CloudIcon,
    Link as PairIcon,
    PencilLine as DraftIcon,
    Plus as PlusIcon,
    RefreshCw as ScanIcon,
    RotateCw as RetryIcon,
    Wifi as NearbyIcon,
  } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { runtime, serversStore, hostStatusDotClass } from "../../contexts";
  import { cn } from "../../lib/utils";
  import { isStackedPane } from "../../lib/pane-width";
  import { Button } from "../ui/button";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import { isManagedHost } from "../servers/lib/managed-host";
  import { hostOnboardingStore } from "../servers/host-onboarding.store.svelte";
  import { cloudOnboardingStore as cloud } from "../onboarding/cloud-onboarding.store.svelte";
  import {
    connectHostHeadline,
    connectHostRow,
    CONNECT_HOST_ACTION_LABELS,
    type ConnectHostRow,
    type GatedHost,
  } from "./lib/host-gate";

  /**
   * What a draft pane shows in place of its composer while no host can run the
   * draft (docs/plans/draft-connect-host.md): every saved host and its state,
   * hosts found nearby, and the ways to add one. The draft's text is kept, and
   * the composer comes back the moment a host answers.
   */
  interface Props {
    hosts: readonly GatedHost[];
    /** The text the person wrote before every host went away. */
    draftText: string;
    surfaceVisible: boolean;
    /** Beside another pane: smaller type, same content. */
    compact: boolean;
    /** The pane's clock, so "last seen" stays current. */
    now: number;
  }

  let { hosts, draftText, surfaceVisible, compact, now }: Props = $props();

  let paneWidth = $state(0);
  const isSmall = $derived(compact || isStackedPane(paneWidth));
  let optionList = $state<HTMLElement | null>(null);

  /** The host the person asked to connect; the page waits on it alone. */
  let connectingHostId = $state<string | null>(null);
  /** The last host that did not answer when asked, so its card says so. */
  let failedHostId = $state<string | null>(null);
  const connectingHost = $derived(hosts.find((host) => host.id === connectingHostId) ?? null);
  const rows = $derived(hosts.map((host) => connectHostRow(host, now)));
  const nearby = $derived(serversStore.nearbyHosts);
  const headline = $derived(connectHostHeadline(hosts, connectingHost?.label ?? null));

  onMount(() => {
    // Opening the page is a refresh point, as opening Connections is.
    void serversStore.refreshDirectory();
    void serversStore.probeHosts();
  });

  // The first card takes focus so Enter runs it. Re-run when the list returns
  // from the connecting view, which unmounts it.
  $effect(() => {
    if (!surfaceVisible || !optionList || runtime.shouldSuppressFocus) return;
    const frame = requestAnimationFrame(() =>
      optionList?.querySelector<HTMLElement>("[data-connect-option]")?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  });

  async function connect(hostId: string, attempt: () => Promise<boolean>) {
    connectingHostId = hostId;
    failedHostId = null;
    const hasAnswered = await attempt();
    if (hasAnswered || connectingHostId !== hostId) return;
    connectingHostId = null;
    failedHostId = hostId;
  }

  function runRow(row: ConnectHostRow) {
    if (row.action === "retry") void connect(row.hostId, () => serversStore.connectNow(row.hostId));
    else if (row.action === "start") void connect(row.hostId, () => serversStore.startManagedHost(row.hostId));
    else if (row.action === "pair-again") {
      serversStore.openAddServer(hosts.find((host) => host.id === row.hostId)?.url ?? "");
    }
  }

  /** Arrow keys walk the cards; Enter is each card's own button. */
  function moveFocus(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = [...(optionList?.querySelectorAll<HTMLElement>("[data-connect-option]") ?? [])];
    const index = options.findIndex((element) => element === document.activeElement);
    const next = options[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }
</script>

{#snippet tile(Icon: typeof CloudIcon, host: GatedHost | null)}
  <span class="relative grid size-8 shrink-0 place-items-center rounded-[0.5625rem] bg-(--solus-surface-hover) text-(--solus-text-tertiary)">
    {#if host}
      <HostOperatingSystemIcon os={host.os} managed={isManagedHost(host.uplink)} size={15} />
      <!-- A host that never answers would pulse for ever; the dot holds still. -->
      <span
        class={cn(
          "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-(--solus-input-pill-bg)",
          host.status === "connecting" ? "bg-(--solus-accent)" : hostStatusDotClass(host.status),
        )}
      ></span>
    {:else}
      <Icon size={15} />
    {/if}
  </span>
{/snippet}

{#snippet option(
  Icon: typeof CloudIcon,
  host: GatedHost | null,
  label: string,
  detail: string,
  actionLabel: string | null,
  onSelect: (() => void) | null,
)}
  {@const body = `${label}. ${detail}`}
  <!-- A card with nothing to do (a host still dialing) stays a disabled
       button, so it reads as a status and the arrow keys pass over it. -->
  <button
    type="button"
    disabled={!onSelect}
    data-connect-option={onSelect ? "" : undefined}
    aria-label={onSelect && actionLabel ? `${actionLabel} ${label}` : body}
    onclick={() => onSelect?.()}
    class={cn(
      "flex w-full items-center gap-3.5 overflow-hidden rounded-2xl bg-(--solus-input-pill-bg) px-4 py-3.5 text-left",
      "shadow-[shadow:0_0_0_0.03125rem_var(--solus-container-border),0_12px_28px_-20px_rgb(0_0_0/35%)] dark:shadow-[shadow:0_0_0_0.03125rem_var(--solus-container-border)]",
      onSelect &&
        "cursor-pointer transition-[box-shadow,scale] duration-[var(--duration-quick)] ease-(--ease-premium) focus-visible:outline-none focus-visible:shadow-[shadow:0_0_0_0.0625rem_color-mix(in_oklch,var(--solus-accent)_34%,transparent),0_0_0_0.25rem_color-mix(in_oklch,var(--solus-accent)_9%,transparent)] active:scale-[0.99] [@media(hover:hover)]:hover:shadow-[shadow:0_0_0_0.0625rem_var(--solus-container-border),0_12px_28px_-18px_rgb(0_0_0/40%)]",
    )}
  >
    {@render tile(Icon, host)}
    <span class="min-w-0 flex-1">
      <span class="block truncate text-workspace-chrome font-medium text-(--solus-text-primary)">{label}</span>
      <span class="mt-0.5 block truncate text-chrome-dense text-(--solus-text-tertiary)">{detail}</span>
    </span>
    {#if actionLabel}
      <span class="flex shrink-0 items-center gap-1 rounded-full bg-(--solus-accent-soft) px-2.5 py-0.5 text-xs text-(--solus-accent)">
        {#if actionLabel === CONNECT_HOST_ACTION_LABELS.retry}<RetryIcon size={11} />{/if}{actionLabel}
      </span>
    {:else if onSelect}
      <ChevronIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" />
    {/if}
  </button>
{/snippet}

<div
  bind:clientWidth={paneWidth}
  class={cn(
    "flex h-full min-h-0 w-full flex-col items-center overflow-y-auto",
    isSmall ? "justify-start px-[1.125rem] pt-8 pb-6" : "justify-center px-6 py-10",
  )}
>
  <div class="flex w-full max-w-[32rem] flex-col">
    <h1
      class={cn(
        "text-center text-pretty text-(--solus-text-primary)",
        isSmall ? "text-2xl leading-[1.3] font-medium tracking-[-0.018em]" : "text-3xl leading-[1.25] font-normal tracking-tight",
      )}
    >
      {headline}
    </h1>
    <p class="mt-2 mb-6 text-center text-workspace-chrome text-pretty text-(--solus-text-tertiary)">
      {#if connectingHost}
        Solus opens the composer when {connectingHost.label} answers.
      {:else if hosts.length === 0}
        A host is a machine that has your code. Solus runs agents there.
      {:else}
        Agents run on your machines. Connect one to start.
      {/if}
    </p>

    {#if connectingHost}
      <div class="flex justify-center">
        <Button
          variant="ghost"
          size="sm"
          class="text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
          onclick={() => (connectingHostId = null)}
        >
          Choose another host
        </Button>
      </div>
    {:else}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div bind:this={optionList} class="flex flex-col gap-2" onkeydown={moveFocus}>
        {#each rows as row, index (row.hostId)}
          {@const host = hosts[index]}
          {@render option(
            CloudIcon,
            host,
            row.label,
            failedHostId === row.hostId && row.action === "retry" ? "Did not answer · try again" : row.detail,
            row.action && CONNECT_HOST_ACTION_LABELS[row.action],
            row.action ? () => runRow(row) : null,
          )}
        {/each}
        {#each nearby as nearbyHost (nearbyHost.server.installationId)}
          {@render option(
            NearbyIcon,
            null,
            nearbyHost.server.name,
            "Found on this network",
            "Connect",
            () => hostOnboardingStore.openForDiscovered(nearbyHost.server),
          )}
        {/each}
        {#if hosts.length === 0}
          {@render option(
            PairIcon,
            null,
            "Pair another machine",
            "Install Solus there, then enter its address or pairing code.",
            null,
            () => serversStore.openAddServer(),
          )}
          {#if cloud.isCloud}
            {@render option(
              CloudIcon,
              null,
              "Cloud host",
              "A machine Solus runs for your organization.",
              null,
              () => cloud.reopenAt("compute"),
            )}
          {/if}
        {/if}
      </div>

      <div class="mt-4 flex justify-center gap-1">
        {#if hosts.length > 0}
          <Button
            variant="ghost"
            size="sm"
            class="text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
            onclick={() => serversStore.openAddServer()}
          >
            <PlusIcon size={13} />
            Add host
          </Button>
        {/if}
        <Button
          variant="ghost"
          size="sm"
          class="text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
          disabled={serversStore.discoveryBusy}
          onclick={() => void serversStore.scanForServers()}
        >
          <ScanIcon size={13} />
          {serversStore.discoveryBusy ? "Scanning…" : "Scan network"}
        </Button>
      </div>
    {/if}

    {#if draftText}
      <p class="mt-4 flex min-w-0 items-center justify-center gap-2 text-chrome-dense text-(--solus-text-tertiary)">
        <DraftIcon size={12} class="shrink-0" />
        <span class="shrink-0">Draft kept:</span>
        <span class="min-w-0 truncate text-(--solus-text-secondary)">“{draftText}”</span>
      </p>
    {/if}
  </div>
</div>
