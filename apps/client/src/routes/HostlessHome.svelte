<script lang="ts">
  import {
    ArrowRightIcon,
    HardDrivesIcon,
    LinkSimpleIcon,
    XIcon,
  } from "phosphor-svelte";
  import {
    loadServers,
    removeServer,
    type SavedServer,
  } from "@solus/client-core/server-registry";
  import { defaultDeviceLabel, urlHost } from "@solus/client-core/pairing";
  import { toasts } from "@solus/workspace-ui/lib/toasts";
  import {
    addHostFromInput,
    probeServingOrigin,
    type OfferedHost,
  } from "../lib/add-host";
  import { classifyConnectInput, probeServer } from "../lib/connect";
  import { activateServer } from "../lib/primary-connection";

  // The hostless home is the one surface allowed to exist without a primary
  // connection: the workspace's founding invariant is that a host is connected
  // before it mounts, so this scene lives in the small entry chunk and hands
  // off through activateServer(), which reloads into the workspace boot path.

  let savedServers = $state<SavedServer[]>(loadServers());
  /** Reachability per saved host id; absent while the probe is in flight. */
  let reachable = $state<Partial<Record<string, boolean>>>({});
  /** The server that served this page, when it is one we could still add. */
  let servingHost = $state<OfferedHost | null>(null);
  /** Set when the user picks the offered host instead of typing an address. */
  let selectedHost = $state<OfferedHost | null>(null);

  let smartInput = $state("");
  let codeInput = $state("");
  let labelInput = $state("");
  let busy = $state(false);
  let smartInputEl: HTMLInputElement | null = $state(null);
  let codeInputEl: HTMLInputElement | null = $state(null);

  // A pasted pairing link carries its own token; a bare address (typed or
  // offered) still needs the 6-digit code the host shows in Settings.
  const needsCode = $derived(
    !!selectedHost || classifyConnectInput(smartInput).kind === "address",
  );

  $effect(() => {
    void probeServingOrigin(location.origin).then((host) => {
      servingHost = host;
    });
    for (const server of loadServers()) {
      void probeServer(server.url).then((health) => {
        reachable[server.id] = health.ok;
      });
    }
    // A phone would only get its keyboard thrown over the list of hosts.
    if (!window.matchMedia("(max-width: 767px)").matches) {
      smartInputEl?.focus();
    }
  });

  function selectHost(host: OfferedHost) {
    selectedHost = host;
    smartInput = "";
    setTimeout(() => codeInputEl?.focus(), 60);
  }

  function clearSelectedHost() {
    selectedHost = null;
    codeInput = "";
    setTimeout(() => smartInputEl?.focus(), 60);
  }

  function forgetServer(serverId: string) {
    removeServer(serverId);
    savedServers = loadServers();
  }

  async function submit(event: Event) {
    event.preventDefault();
    busy = true;
    try {
      const server = await addHostFromInput({
        input: selectedHost?.url ?? smartInput,
        code: codeInput,
        serverLabel: labelInput,
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

<!-- Same posture as the workspace's new-tab home: one headline, then the one
     thing this screen exists for. -->
<div
  class="text-sm text-xs flex min-h-dvh w-full flex-col items-center justify-center gap-8 overflow-y-auto bg-(--solus-bg) px-5 py-10"
  data-solus-ui
>
  <header class="flex max-w-[26rem] flex-col items-center gap-2 text-center">
    <h1
      class="text-pretty text-2xl font-medium leading-[1.25] text-(--solus-text-primary)"
    >
      Connect a host to get started
    </h1>
    <p class="leading-relaxed text-(--solus-text-tertiary)">
      Sessions run on a host — your computer or a machine you pair once. After
      that, Solus reconnects on its own.
    </p>
  </header>

  <main class="flex w-full max-w-[26rem] flex-col gap-4">
    {#if servingHost && !selectedHost}
      <section>
        <span
          class="mb-1 block px-1 font-semibold uppercase tracking-[0.03em] text-(--solus-text-tertiary)"
          >On this address</span
        >
        <div
          class="flex flex-col overflow-hidden rounded-2xl border border-(--solus-container-border) bg-(--solus-surface-hover)/40 p-1"
        >
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-[var(--duration-quick)] hover:bg-(--solus-surface-hover) focus-visible:bg-(--solus-surface-hover) focus-visible:outline-none"
            onclick={() => selectHost(servingHost!)}
          >
            <HardDrivesIcon
              size={14}
              class="shrink-0 text-(--solus-text-tertiary)"
            />
            <span class="flex min-w-0 flex-1 flex-col">
              <span
                class="truncate  font-medium text-(--solus-text-primary)"
                >{servingHost.name}</span
              >
              <span class="truncate font-mono text-(--solus-text-tertiary)"
                >{urlHost(servingHost.url)}</span
              >
            </span>
            <span class="shrink-0 font-medium text-(--solus-accent)"
              >Connect</span
            >
          </button>
        </div>
      </section>
    {/if}

    {#if savedServers.length > 0}
      <section>
        <span
          class="mb-1 block px-1 font-semibold uppercase tracking-[0.03em] text-(--solus-text-tertiary)"
          >Your hosts</span
        >
        <div
          class="flex flex-col overflow-hidden rounded-2xl border border-(--solus-container-border) bg-(--solus-surface-hover)/40 p-1"
        >
          {#each savedServers as server (server.id)}
            <div class="group flex items-center">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-[var(--duration-quick)] hover:bg-(--solus-surface-hover) focus-visible:bg-(--solus-surface-hover) focus-visible:outline-none"
                onclick={() => activateServer(server)}
              >
                <span
                  class="size-2 shrink-0 rounded-full {reachable[server.id] ===
                  true
                    ? 'bg-emerald-500'
                    : reachable[server.id] === false
                      ? 'bg-(--solus-text-quaternary)'
                      : 'animate-pulse bg-(--solus-text-quaternary)'}"
                  aria-hidden="true"
                ></span>
                <span class="flex min-w-0 flex-1 flex-col">
                  <span
                    class="truncate  font-medium text-(--solus-text-primary)"
                    >{server.label}</span
                  >
                  <span
                    class="truncate font-mono text-(--solus-text-tertiary)"
                    >{urlHost(server.url)}</span
                  >
                </span>
                <ArrowRightIcon
                  size={14}
                  class="shrink-0 text-(--solus-text-quaternary) opacity-0 transition-opacity duration-[var(--duration-quick)] group-hover:opacity-100"
                />
              </button>
              <button
                type="button"
                class="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-(--solus-text-quaternary) opacity-0 transition-[opacity,color] hover:text-(--solus-text-primary) focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100 pointer-coarse:opacity-100"
                aria-label={`Forget ${server.label}`}
                onclick={() => forgetServer(server.id)}
              >
                <XIcon size={12} />
              </button>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <section>
      <span
        class="mb-1 block px-1 font-semibold uppercase tracking-[0.03em] text-(--solus-text-tertiary)"
        >{savedServers.length > 0 || servingHost
          ? "Add a host"
          : "Connect"}</span
      >
      <form
        class="flex flex-col gap-2.5 rounded-2xl border border-(--solus-container-border) bg-(--solus-surface-hover)/40 p-3"
        onsubmit={submit}
      >
        {#if selectedHost}
          <p
            class="rounded-lg bg-(--solus-surface-hover) px-3 py-2 leading-relaxed text-(--solus-text-tertiary)"
          >
            On {selectedHost.name}, open Solus and go to <strong
              class="font-medium text-(--solus-text-secondary)"
              >Settings → Connections</strong
            > for the 6-digit code.
          </p>
          <div
            class="flex items-center gap-3 rounded-lg border border-(--solus-container-border) bg-(--solus-accent-light) px-3 py-2.5"
          >
            <HardDrivesIcon size={14} class="shrink-0 text-(--solus-accent)" />
            <span class="flex min-w-0 flex-1 flex-col">
              <span
                class="truncate  font-medium text-(--solus-text-primary)"
                >{selectedHost.name}</span
              >
              <span class="truncate font-mono text-(--solus-text-tertiary)"
                >{urlHost(selectedHost.url)}</span
              >
            </span>
            <button
              type="button"
              class="shrink-0 rounded-md px-1.5 py-1 font-medium text-(--solus-text-tertiary) transition-colors hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
              onclick={clearSelectedHost}
            >
              Change
            </button>
          </div>
        {:else}
          <p
            class="rounded-lg bg-(--solus-surface-hover) px-3 py-2 leading-relaxed text-(--solus-text-tertiary)"
          >
            On your computer, open Solus and go to <strong
              class="font-medium text-(--solus-text-secondary)"
              >Settings → Connections</strong
            >. Scan the QR code, or paste the pairing link or address here.
          </p>
          <label class="block">
            <span class="text-xs font-medium text-(--solus-text-secondary)"
              >Pairing link or address</span
            >
            <input
              bind:this={smartInputEl}
              bind:value={smartInput}
              type="text"
              class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2  text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]"
              placeholder="192.168.1.42:51234 or pairing link"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
            />
          </label>
        {/if}

        {#if needsCode}
          <label class="block">
            <span class="text-xs font-medium text-(--solus-text-secondary)"
              >Code</span
            >
            <input
              bind:this={codeInputEl}
              bind:value={codeInput}
              type="text"
              class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2  tracking-[0.16em] text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]"
              placeholder="000000"
              inputmode="numeric"
              maxlength="6"
              autocomplete="one-time-code"
            />
          </label>
        {/if}

        <label class="block">
          <span class="text-xs font-medium text-(--solus-text-secondary)">
            Device name
            <span class="font-normal text-(--solus-text-tertiary)">optional</span>
          </span>
          <input
            bind:value={labelInput}
            type="text"
            class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2  text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]"
            placeholder={defaultDeviceLabel()}
            autocomplete="off"
          />
        </label>

        <button
          type="submit"
          disabled={busy}
          class="inline-flex items-center justify-center gap-2 rounded-lg bg-(--solus-accent) px-3 py-2  font-medium text-(--solus-text-on-accent) transition-[opacity,transform] active:scale-[0.98] disabled:cursor-wait disabled:opacity-60"
        >
          <LinkSimpleIcon size={14} />
          {busy ? "Connecting…" : "Connect"}
        </button>
      </form>
    </section>
  </main>
</div>
