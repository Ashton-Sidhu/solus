<script lang="ts">
  import { removeServer } from "@solus/client-core/server-registry";
  import { onMount, tick } from "svelte";
  import { HostlessHostsStore } from "./lib/hostless-hosts.store.svelte";
  import {
    ChevronRight as ChevronIcon,
    Cloud as CloudIcon,
    Database as HardDrivesIcon,
    Link2 as LinkSimpleIcon,
    Wifi as NearbyIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { cn } from "@solus/workspace-ui/lib/utils";
  import { cardClass, fieldClass } from "./lib/hostless-styles";
  import { urlHost } from "@solus/client-core/pairing";
  import { defaultDeviceLabel } from "@solus/client-core/device-label";
  import { preferredRouteUrl } from "@solus/client-core/server-connection";
  import { toasts } from "@solus/workspace-ui/lib/toasts";
  import {
    addHostFromInput,
    type OfferedHost,
  } from "../lib/add-host";
  import { classifyConnectInput } from "../lib/connect";
  import { cloudOrigin } from "../lib/cloud-origin.svelte";
  import { activateServer } from "../lib/primary-connection";

  const hosts = new HostlessHostsStore();
  const savedServers = $derived(hosts.servers);
  const servingHost = $derived(hosts.servingHost);

  /** Set when the user picks the offered host instead of typing an address. */
  let selectedHost = $state<OfferedHost | null>(null);

  let smartInput = $state("");
  let codeInput = $state("");
  let labelInput = $state("");
  let busy = $state(false);
  let smartInputEl: HTMLInputElement | null = $state(null);
  let codeInputEl: HTMLInputElement | null = $state(null);
  let mainEl: HTMLElement | null = $state(null);

  /** The pairing form is open: chosen from its card, or the only way in. */
  let isPairing = $state(false);
  const showsPairingForm = $derived(
    isPairing || !!selectedHost || (savedServers.length === 0 && !servingHost),
  );

  // A pasted pairing link carries its own token; a bare address (typed or
  // offered) still needs the 6-digit code the host shows in Settings.
  const needsCode = $derived(
    !!selectedHost || classifyConnectInput(smartInput).kind === "address",
  );

  onMount(() => hosts.start(location.origin));
  onMount(() => {
    // The pairing field when it is the only way in, else the first card.
    if (window.matchMedia("(max-width: 767px)").matches) return;
    (smartInputEl ?? mainEl?.querySelector<HTMLElement>("button, a"))?.focus();
  });

  async function selectHost(host: OfferedHost) {
    selectedHost = host;
    smartInput = "";
    await tick();
    codeInputEl?.focus();
  }

  async function clearSelectedHost() {
    selectedHost = null;
    codeInput = "";
    await tick();
    smartInputEl?.focus();
  }

  async function openPairing() {
    isPairing = true;
    await tick();
    smartInputEl?.focus();
  }

  async function submit(event: Event) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    try {
      const server = await addHostFromInput({
        input: selectedHost?.url ?? smartInput,
        code: codeInput,
        deviceLabel: labelInput,
      });
      // Activation reloads the page, so `busy` deliberately stays set — the
      // form must not accept a second submission while that lands.
      activateServer(server);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : String(err));
      busy = false;
    }
  }
</script>

<!-- The same page a draft shows when no host can run it
     (docs/plans/draft-connect-host.md): one headline, then one card for each
     way in. -->
<div
  class="@container flex min-h-dvh w-full flex-col items-center justify-center overflow-y-auto bg-(--solus-bg) px-5 py-10"
  data-solus-ui
>
  <div class="flex w-full max-w-[32rem] flex-col">
    <h1
      class="text-center text-pretty text-2xl leading-[1.3] font-medium tracking-[-0.018em] text-(--solus-text-primary) @min-[36rem]:text-3xl @min-[36rem]:font-normal @min-[36rem]:tracking-tight"
    >
      {savedServers.length > 0 ? "Choose a host to start" : "Connect a host to start"}
    </h1>
    <p class="mt-2 mb-6 text-center text-workspace-chrome text-pretty text-(--solus-text-tertiary)">
      A host is a machine that has your code. Solus runs agents there and
      reconnects on its own.
    </p>

    <main bind:this={mainEl} class="flex flex-col gap-2">
      {#each savedServers as server (server.id)}
        {@const reachable = hosts.reachable.get(server.id)}
        <div class={cn(cardClass, "pr-2")}>
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-3.5 overflow-hidden py-3.5 pl-4 text-left focus-visible:outline-none"
            onclick={() => activateServer(server)}
          >
            {@render tile(HardDrivesIcon, reachable === true ? "online" : reachable === false ? "offline" : "unknown")}
            {@render text(
              server.label,
              `${reachable === false ? "Offline · " : ""}${urlHost(preferredRouteUrl(server))}`,
            )}
            {@render pill("Open")}
          </button>
          <button
            type="button"
            class="flex size-7 shrink-0 items-center justify-center rounded-md text-(--solus-text-quaternary) opacity-0 transition-[opacity,color] group-hover/card:opacity-100 hover:text-(--solus-text-primary) focus-visible:opacity-100 focus-visible:outline-none pointer-coarse:opacity-100"
            aria-label={`Forget ${server.label}`}
            onclick={() => removeServer(server.id)}
          >
            <XIcon size={12} />
          </button>
        </div>
      {/each}

      {#if servingHost && !selectedHost}
        <button type="button" class={cn(cardClass, "px-4 py-3.5 text-left")} onclick={() => selectHost(servingHost!)}>
          {@render tile(NearbyIcon, null)}
          {@render text(servingHost.name, `On this address · ${urlHost(servingHost.url)}`)}
          {@render pill("Connect")}
        </button>
      {/if}

      {#if cloudOrigin.kind === "signed-out"}
        <!-- Served by the account origin: the directory is one sign-in away. -->
        <a href={cloudOrigin.signInUrl} class={cn(cardClass, "px-4 py-3.5")}>
          {@render tile(CloudIcon, null)}
          {@render text("Solus Cloud", "Sign in to see the hosts linked to your account.")}
          {@render pill("Sign in")}
        </a>
      {:else if cloudOrigin.kind === "signed-in" && savedServers.length === 0}
        <!-- Signed in with nothing listed: say where linking happens. -->
        <a href={cloudOrigin.linkMachineUrl} class={cn(cardClass, "px-4 py-3.5")}>
          {@render tile(CloudIcon, null)}
          {@render text(
            "Link a computer to your account",
            "In Solus on your computer, open Settings → Account & sync → Link to Solus Cloud, or get a link code to paste there.",
            true,
          )}
          <ChevronIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" />
        </a>
      {/if}

      {#if showsPairingForm}
        <form class={cn(cardClass, "flex-col items-stretch gap-3 p-4")} onsubmit={submit}>
          {#if selectedHost}
            <div class="flex items-center gap-3.5">
              {@render tile(NearbyIcon, null)}
              {@render text(selectedHost.name, urlHost(selectedHost.url))}
              <button
                type="button"
                class="shrink-0 rounded-md px-1.5 py-1 text-xs font-medium text-(--solus-text-tertiary) transition-colors hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
                onclick={clearSelectedHost}
              >
                Change
              </button>
            </div>
            <p class="text-chrome-dense leading-relaxed text-pretty text-(--solus-text-tertiary)">
              On {selectedHost.name}, open Solus and go to
              <strong class="font-medium text-(--solus-text-secondary)">Settings → Hosts → this computer → Access</strong>
              for the 6-digit code. On a server without a screen, run
              <code class="font-mono text-(--solus-text-secondary)">solus pair</code>.
            </p>
          {:else}
            <div class="flex items-center gap-3.5">
              {@render tile(LinkSimpleIcon, null)}
              {@render text(
                "Pair another machine",
                "Paste the pairing link or address from Settings → Hosts → Access on that computer, or run solus pair on a server.",
                true,
              )}
            </div>
            <input
              bind:this={smartInputEl}
              bind:value={smartInput}
              type="text"
              aria-label="Pairing link or address"
              class={fieldClass}
              placeholder="192.168.1.42:3000 or pairing link"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
            />
          {/if}

          {#if needsCode}
            <input
              bind:this={codeInputEl}
              bind:value={codeInput}
              type="text"
              aria-label="Code"
              class={cn(fieldClass, "tracking-[0.16em]")}
              placeholder="6-digit code"
              inputmode="numeric"
              maxlength="6"
              autocomplete="one-time-code"
            />
          {/if}

          <input
            bind:value={labelInput}
            type="text"
            aria-label="Device name (optional)"
            class={fieldClass}
            placeholder={`Device name · ${defaultDeviceLabel()}`}
            autocomplete="off"
          />

          <button
            type="submit"
            disabled={busy}
            class="inline-flex items-center justify-center gap-2 self-end rounded-full bg-(--solus-accent) px-4 py-1.5 text-workspace-chrome font-medium text-(--solus-text-on-accent) transition-[opacity,scale] active:scale-[0.98] disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
      {:else}
        <button type="button" class={cn(cardClass, "px-4 py-3.5 text-left")} onclick={openPairing}>
          {@render tile(LinkSimpleIcon, null)}
          {@render text("Pair another machine", "Enter its pairing link or address.")}
          <ChevronIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" />
        </button>
      {/if}
    </main>
  </div>
</div>

{#snippet tile(Icon: typeof CloudIcon, status: "online" | "offline" | "unknown" | null)}
  <span class="relative grid size-8 shrink-0 place-items-center rounded-[0.5625rem] bg-(--solus-surface-hover) text-(--solus-text-tertiary)">
    <Icon size={15} />
    {#if status}
      <span
        class={cn(
          "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-(--solus-input-pill-bg)",
          status === "online"
            ? "bg-(--solus-status-complete)"
            : status === "offline"
              ? "bg-(--solus-status-error)"
              : "bg-(--solus-text-quaternary)",
        )}
        aria-hidden="true"
      ></span>
    {/if}
  </span>
{/snippet}

{#snippet text(label: string, detail: string, wraps = false)}
  <span class="min-w-0 flex-1">
    <span class="block truncate text-workspace-chrome font-medium text-(--solus-text-primary)">{label}</span>
    <span
      class={cn(
        "mt-0.5 block text-chrome-dense text-(--solus-text-tertiary)",
        wraps ? "leading-relaxed text-pretty" : "truncate",
      )}>{detail}</span
    >
  </span>
{/snippet}

{#snippet pill(label: string)}
  <span class="shrink-0 rounded-full bg-(--solus-accent-soft) px-2.5 py-0.5 text-xs text-(--solus-accent)">{label}</span>
{/snippet}
