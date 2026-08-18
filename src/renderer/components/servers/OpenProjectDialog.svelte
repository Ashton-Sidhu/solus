<script lang="ts">
  import { fade, fly, slide } from "svelte/transition";
  import { expoOut } from "svelte/easing";
  import {
    ArrowLeftIcon,
    CaretDownIcon,
    CheckIcon,
    DesktopTowerIcon,
    XIcon,
  } from "phosphor-svelte";
  import { Button } from "../ui/button";
  import Kbd from "../ui/Kbd.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { getPopoverLayer } from "../popoverLayer.svelte";
  import { portal } from "../portal";
  import {
    blurActiveTextInputOnMobile,
    requestInputFocus,
  } from "../../lib/inputFocus";
  import { abbreviateHome, truncateMiddle } from "../../lib/paths";
  import { connectionsStore, hostStatusDotClass, runtime, serversStore } from "../../contexts";
  import OpenProjectDestination from "./OpenProjectDestination.svelte";
  import OpenProjectHome from "./OpenProjectHome.svelte";
  import { openProjectStore as store } from "./open-project.store.svelte";
  import type { CloneFailure } from "./lib/clone-outcome";
  import { homeRows } from "./lib/open-project-home";
  import HostOperatingSystemIcon from "./HostOperatingSystemIcon.svelte";

  interface Props {
    /** Runs with the host-absolute path the flow committed to. */
    onOpenProject: (path: string) => void;
    /** Opens the host-scoped folder browser for the secondary action. */
    onBrowse: () => void;
    /** A clone that failed after the dialog was dismissed reports here. */
    onBackgroundCloneFailure: (failure: CloneFailure) => void;
    /** This client's git identity, offered as the prefill for a bare host. */
    localIdentity?: { name: string; email: string } | null;
  }

  let { onOpenProject, onBrowse, onBackgroundCloneFailure, localIdentity = null }: Props = $props();

  const layer = getPopoverLayer();

  let dialogEl: HTMLDivElement | null = $state(null);
  let inputEl: HTMLInputElement | HTMLTextAreaElement | null = $state(null);
  let logPaneEl: HTMLDivElement | null = $state(null);
  let bodyHeight = $state(0);
  let hasMeasured = $state(false);
  let highlightedIndex = $state(0);
  let showOutput = $state(false);
  let hostMenuOpen = $state(false);

  const hosts = $derived(serversStore.servers);
  const multiHost = $derived(hosts.length > 1);
  const selectedHost = $derived(hosts.find((host) => host.id === store.serverId));
  // GitHub credentials are per-machine, but the question home asks is about
  // *you* — so the row is gated on this client's sign-in, and a chosen host
  // that lacks its own token gets a connect panel rather than a dead end.
  const githubAvailable = $derived(
    connectionsStore.capabilities?.gitAuth?.github === true,
  );

  const rows = $derived(
    homeRows({
      intent: store.homeIntent,
      recents: store.filteredRecents,
      githubAvailable,
    }),
  );

  /** How many rows ↑↓ walk on the current step. */
  const rowCount = $derived.by(() => {
    if (store.step === "home") return rows.length;
    if (store.step === "destination" && store.source === "github") {
      return store.needsGithubOnHost ? 0 : store.filteredRepos.length;
    }
    return 0;
  });
  const clampedHighlightedIndex = $derived(
    Math.min(highlightedIndex, Math.max(rowCount - 1, 0)),
  );

  const isGithub = $derived(store.step === "destination" && store.source === "github");
  const rootLabel = $derived(truncateMiddle(abbreviateHome(store.projectsRoot), 22));
  const destination = $derived(store.destinationPreview);
  const title = $derived.by(() => {
    if (store.step === "home") return "Open project";
    if (store.step === "cloning") return "Cloning";
    return isGithub ? "Clone from GitHub" : "Clone from a URL";
  });
  // Each view is sized to its content: the repo list needs room the clone form
  // does not, and home sits between them.
  const panelWidth = $derived.by(() => {
    if (store.step === "home") return "42rem";
    return isGithub ? "45rem" : "39rem";
  });
  const tailLogLine = $derived(store.logLines[store.logLines.length - 1] ?? "");

  $effect(() => {
    if (!store.isOpen || store.step === "browse") return;
    const step = store.step;
    blurActiveTextInputOnMobile();
    if (runtime.shouldSuppressFocus) return;
    // Home and the destination both have a field; the cloning view has none, so
    // focus stays on the dialog for Escape to reach it.
    requestAnimationFrame(() =>
      (step === "cloning" ? dialogEl : (inputEl ?? dialogEl))?.focus(),
    );
  });

  // The stream is only useful pinned to its tail; a growing pane that stays at
  // the top just hides the line you're waiting for.
  $effect(() => {
    void store.logLines.length;
    if (logPaneEl) logPaneEl.scrollTop = logPaneEl.scrollHeight;
  });

  // A failed clone lands back on the form with its output already open, because
  // the reason is in those lines and nothing else on screen carries it.
  $effect(() => {
    if (store.cloneStatus === "running") showOutput = true;
  });

  $effect(() => {
    if (bodyHeight > 0) hasMeasured = true;
  });

  function browseFolder() {
    highlightedIndex = 0;
    store.browseFolder();
    onBrowse();
  }

  function goBack() {
    highlightedIndex = 0;
    store.back();
  }

  function selectHost(host: (typeof hosts)[number]) {
    highlightedIndex = 0;
    store.selectHost(host);
  }

  function activate(index: number) {
    if (store.step === "home") {
      const row = rows[index];
      if (!row) return;
      if (row.kind === "clone") {
        highlightedIndex = 0;
        store.chooseCloneUrl(row.seed);
      } else if (row.kind === "recent") {
        // A recent is a folder that already exists, so the open reads as one
        // rather than as a clone that never ran.
        store.openRecent();
        onOpenProject(row.project.path);
      } else if (row.action === "browse") {
        browseFolder();
      } else if (row.action === "github") {
        highlightedIndex = 0;
        store.chooseGithub();
      } else {
        highlightedIndex = 0;
        store.chooseCloneUrl();
      }
      return;
    }
    if (isGithub) {
      const repo = store.filteredRepos[index];
      if (repo) store.selectRepo(repo.fullName);
    }
    void submit();
  }

  async function submit() {
    if (!store.canSubmit) return;
    const path = await store.clone();
    if (!path) {
      // A clone that failed after the dialog was dismissed has no form to land
      // its error on — say so, or the failure is silent.
      if (!store.isOpen && store.cloneFailure) onBackgroundCloneFailure(store.cloneFailure);
      return;
    }
    onOpenProject(path);
  }

  /** "Use it" on an occupied destination: register the checkout the host already has. */
  async function adoptExistingFolder() {
    const path = await store.adoptOccupiedDestination();
    if (!path) return;
    onOpenProject(path);
  }

  async function connectGithub() {
    const boundSetup = store.setup;
    if (!boundSetup) return;
    await boundSetup.runStep("github");
    if (store.setup === boundSetup && store.source === "github") await store.loadRepos();
  }

  function close() {
    store.close();
    requestInputFocus();
  }

  function trapFocus(e: KeyboardEvent) {
    if (!dialogEl) return;
    const focusable = Array.from(
      dialogEl.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /**
   * Bound to the window rather than the dialog: every step swaps the element
   * that had focus, and a dialog-scoped handler goes deaf the moment focus
   * lands on the body between them. Capture phase so the global dispatcher
   * never sees a key this flow has already answered.
   */
  function handleKeyDown(e: KeyboardEvent) {
    // The machine menu is a portal of its own; while it is open it owns the keys.
    if (hostMenuOpen) return;
    if (e.key === "Tab") {
      trapFocus(e);
      return;
    }
    if (multiHost && store.step !== "cloning" && e.altKey && e.code === "KeyH") {
      claim(e);
      hostMenuOpen = true;
      return;
    }
    // Escape steps back through the flow before it dismisses it, the same way
    // the command palette leaves a sub-page first. A clone in flight is not
    // stepped back into — it keeps running, and the tab opens when it lands.
    if (e.key === "Escape") {
      claim(e);
      if (store.step === "home" || store.step === "cloning") close();
      else goBack();
      return;
    }
    if (e.key === "Enter") {
      // A real button under focus keeps its native Enter — otherwise tabbing to
      // Cancel and pressing Enter would clone. Option rows stay with the flow:
      // ↑↓ owns which one Enter means.
      const focused = document.activeElement;
      if (
        focused instanceof HTMLButtonElement &&
        focused.getAttribute("role") !== "option" &&
        !e.metaKey &&
        !e.ctrlKey
      ) {
        return;
      }
      claim(e);
      if (e.metaKey || e.ctrlKey) void submit();
      else if (rowCount > 0) activate(clampedHighlightedIndex);
      else void submit();
      return;
    }
    if (e.key === "ArrowDown") {
      claim(e);
      highlightedIndex = Math.min(clampedHighlightedIndex + 1, rowCount - 1);
      return;
    }
    if (e.key === "ArrowUp") {
      claim(e);
      highlightedIndex = Math.max(clampedHighlightedIndex - 1, 0);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o" && store.step === "home") {
      claim(e);
      browseFolder();
      return;
    }
    // Backspace at an empty field steps back out, the way it walks up a folder
    // in the picker.
    if (e.key === "Backspace" && !store.query && store.step === "destination") {
      claim(e);
      goBack();
    }
  }

  /** Only keys the flow acts on are taken; everything else still reaches the field. */
  function claim(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  $effect(() => {
    if (!store.isOpen || store.step === "browse") return;
    const onKeyDown = (e: KeyboardEvent) => handleKeyDown(e);
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });
</script>

{#if store.isOpen && store.step !== "browse" && layer.el}
  <div
    use:portal={layer.el}
    class="text-xs fixed inset-0 z-[200] flex items-start justify-center overflow-hidden overscroll-contain bg-[rgba(28,22,15,0.12)] pt-[12vh]
      max-md:bottom-auto max-md:h-[100dvh] max-md:items-end max-md:pt-0"
    role="presentation"
    onmousedown={(e) => e.target === e.currentTarget && close()}
    transition:fade={{ duration: 120 }}
  >
    <div
      bind:this={dialogEl}
      id="open-project"
      class="flex max-h-[min(85dvh,44rem)] w-full origin-top flex-col overflow-hidden overscroll-contain
        rounded-2xl bg-popover text-foreground
        shadow-[0_1.5rem_4rem_-1rem_rgba(28,22,15,0.34),0_0.0625rem_0.1875rem_rgba(28,22,15,0.10)]
        dark:shadow-[0_1.5rem_4rem_-1rem_rgba(0,0,0,0.55),inset_0_0_0_0.0625rem_var(--border)]
        [transition:max-width_var(--duration-modal)_var(--ease-premium)] motion-reduce:transition-none
        max-md:mt-auto max-md:max-h-[92dvh] max-md:!max-w-full max-md:rounded-b-none max-md:rounded-t-2xl"
      style="max-width:{panelWidth}"
      role="dialog"
      aria-modal="true"
      aria-labelledby="open-project-title"
      tabindex="-1"
      transition:fly={{ y: 10, duration: 220, easing: expoOut }}
    >
      <header class="flex h-14 shrink-0 items-center gap-3 px-5">
        {#if store.step !== "home"}
          <Button
            variant="ghost"
            size="icon-xs"
            class="-ml-1.5 text-muted-foreground"
            aria-label="Back"
            onclick={goBack}
          >
            <ArrowLeftIcon size={13} />
          </Button>
        {/if}
        <h2
          id="open-project-title"
          class="min-w-0 flex-1 truncate text-sm font-medium "
        >
          {title}
        </h2>

        <!-- Which machine is never a step, so it is a control that stays
             reachable from every screen instead. One machine is not a choice,
             so the chip only appears once there is something to switch to. -->
        {#if multiHost && store.step !== "cloning"}
          <DropdownMenu.Root bind:open={hostMenuOpen}>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  class="flex h-6 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2  text-muted-foreground
                    [transition:background-color_var(--duration-quick)_var(--ease-premium)] motion-reduce:transition-none
                    hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-accent)"
                  aria-label="Run on {store.hostLabel || 'this machine'}"
                >
                  {#if selectedHost?.os}
                    <HostOperatingSystemIcon os={selectedHost.os} size={11} class="shrink-0" />
                  {:else if store.hostIsLocal}
                    <DesktopTowerIcon size={11} class="shrink-0" />
                  {:else}
                    <HostOperatingSystemIcon size={11} class="shrink-0" />
                  {/if}
                  <span class="truncate">{store.hostLabel || "This Mac"}</span>
                  <Kbd variant="hint" class="hidden sm:inline-flex">⌥H</Kbd>
                  <CaretDownIcon size={9} class="shrink-0" />
                </button>
              {/snippet}
            </DropdownMenu.Trigger>
            <!-- Portalled into the same layer as the modal: the layer is its own
                 stacking context at z-10010, so a menu left on `document.body`
                 loses to it no matter how high its own z-index is. -->
            <DropdownMenu.Content
              portalProps={{ to: layer.el ?? undefined }}
              side="bottom"
              align="end"
              sideOffset={6}
              class="w-[11.5rem]"
            >
              <DropdownMenu.Label>Run on</DropdownMenu.Label>
              {#each hosts as host (host.id)}
                {@const bound = host.id === store.serverId}
                <DropdownMenu.Item
                  data-menu-current={bound ? "" : undefined}
                  onSelect={() => selectHost(host)}
                >
                  <CheckIcon size={12} class="shrink-0 text-primary {bound ? '' : 'opacity-0'}" />
                  <span class="min-w-0 flex-1 truncate">{host.label}</span>
                  <span
                    class="size-1.5 shrink-0 rounded-full {hostStatusDotClass(host.status)}"
                    title={host.status}
                  ></span>
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        {/if}

        <Button
          variant="ghost"
          size="icon-xs"
          class="-mr-1.5 text-muted-foreground"
          onclick={close}
          aria-label="Cancel"
        >
          <XIcon size={11} />
        </Button>
      </header>

      <!-- One panel that grows into each step rather than four dialogs of
           different sizes flashing past each other. -->
      <div
        class="min-h-0 overflow-y-auto overscroll-contain
          {hasMeasured
          ? '[transition:height_var(--duration-modal)_var(--ease-premium)] motion-reduce:transition-none'
          : ''}"
        style={hasMeasured && bodyHeight > 0 ? `height:${bodyHeight}px` : undefined}
      >
        <div bind:clientHeight={bodyHeight}>
          {#if store.step === "home"}
            <OpenProjectHome
              {store}
              {rows}
              highlightedIndex={clampedHighlightedIndex}
              onHighlight={(index) => (highlightedIndex = index)}
              onActivate={activate}
              bind:inputEl
            />
          {:else if store.step === "cloning"}
            <div class="flex flex-col gap-3 border-t border-border px-5 pb-6 pt-[1.125rem]">
              <div class="flex items-baseline gap-2">
                <span class="shrink-0 text-sm font-medium">{store.projectName ?? "Repository"}</span>
                <span
                  class="min-w-0 truncate  text-muted-foreground"
                  title={destination ?? undefined}
                >
                  {destination ? abbreviateHome(destination) : rootLabel}
                </span>
              </div>
              <!-- A clone reports lines, not percentages, so the bar says "still
                   going" rather than pretending to know how far along it is. -->
              <div class="relative h-[0.1875rem] overflow-hidden rounded-full bg-muted">
                <div class="clone-bar absolute inset-y-0 left-0 w-[32%] rounded-full bg-primary"></div>
              </div>
              <p class="h-4 truncate  text-muted-foreground">{tailLogLine}</p>
              <p class="text-pretty  leading-relaxed text-muted-foreground">
                Keep working — the project opens as soon as the checkout finishes.
              </p>
            </div>
          {:else}
            <OpenProjectDestination
              {store}
              highlightedIndex={clampedHighlightedIndex}
              onHighlight={(index) => (highlightedIndex = index)}
              onActivate={activate}
              bind:inputEl
              {onBrowse}
              {localIdentity}
            />
          {/if}
        </div>
      </div>

      {#if store.step === "destination" && showOutput && store.logLines.length > 0}
        <div
          bind:this={logPaneEl}
          class="max-h-28 shrink-0 overflow-y-auto border-t border-border bg-muted/60 px-4 py-2
            [mask-image:linear-gradient(to_bottom,transparent,black_1.25rem)]"
          transition:slide={{ duration: 160 }}
          role="log"
          aria-live="polite"
        >
          {#each store.logLines as line, index (index)}
            <p class="truncate  leading-relaxed text-muted-foreground">{line}</p>
          {/each}
        </div>
      {/if}

      {#if store.step === "destination"}
        <footer class="flex h-14 shrink-0 items-center gap-3 border-t border-border px-4
          max-md:h-auto max-md:flex-wrap max-md:py-3 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom,0))]">
          <!-- Where the primary button commits, spelled out — the clone lands
               under the host's projects root unless a folder was chosen. -->
          {#if store.cloneFailure}
            {@const failure = store.cloneFailure}
            <span class="min-w-0 flex-1">
              <span class="block text-pretty  font-medium leading-relaxed text-(--solus-status-error)">
                {failure.title}
              </span>
              <span class="mt-0.5 block text-pretty  leading-relaxed text-muted-foreground">
                {failure.detail}
              </span>
            </span>
            {#if failure.kind === "occupied"}
              <!-- The folder is probably the very checkout being asked for, so
                   using it is one click rather than a manual clean-up. -->
              <Button
                class="shrink-0 px-3.5 text-sm"
                disabled={store.adoptingProject}
                onclick={() => void adoptExistingFolder()}
              >
                {store.adoptingProject ? "Checking…" : "Use it"}
              </Button>
            {:else if failure.kind === "auth"}
              <Button
                variant="outline"
                class="shrink-0 text-sm"
                disabled={store.setup?.runningStep === "github"}
                onclick={() => void connectGithub()}
              >
                {store.setup?.runningStep === "github" ? "Waiting for GitHub…" : "Set up"}
              </Button>
            {:else if store.partialPath}
              <Button
                variant="ghost"
                class="shrink-0 text-sm text-muted-foreground"
                onclick={() => void store.clone({ clean: true })}
              >
                Remove partial &amp; retry
              </Button>
            {/if}
          {:else}
            <span
              class="min-w-0 flex-1 truncate  text-muted-foreground"
              title={destination ?? undefined}
            >
              {destination ? abbreviateHome(destination) : `${rootLabel}/…`}
            </span>
          {/if}
          {#if store.logLines.length > 0}
            <Button
              variant="ghost"
              class="shrink-0 text-sm font-normal text-muted-foreground"
              onclick={() => (showOutput = !showOutput)}
            >
              {showOutput ? "Hide output" : "Show output"}
            </Button>
          {/if}
          <Button
            variant="ghost"
            class="shrink-0 text-sm max-md:h-11 max-md:flex-1"
            onclick={goBack}
          >
            Cancel
          </Button>
          <Button
            class="shrink-0 px-3.5 text-sm max-md:h-11 max-md:flex-1"
            disabled={!store.canSubmit}
            onclick={() => void submit()}
          >
            Clone
          </Button>
        </footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .clone-bar {
    animation: clone-sweep 1.1s ease-in-out infinite;
  }
  @keyframes clone-sweep {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(320%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .clone-bar {
      animation: none;
      width: 100%;
      opacity: 0.5;
    }
  }
</style>
