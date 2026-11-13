<script lang="ts">
  import { X as CloseIcon } from "@lucide/svelte";
  import type { AppState, AppSummary } from "@solus/contracts/apps";
  import { PAGE_ICON_BTN } from "../../lib/page-chrome";
  import CopyButton from "../ui/CopyButton.svelte";
  import AppVersions from "./menu/AppVersions.svelte";
  import AppSchedules from "./menu/AppSchedules.svelte";
  import AppSecrets from "./menu/AppSecrets.svelte";
  import AppWebhooks from "./menu/AppWebhooks.svelte";
  import AppCalls from "./menu/AppCalls.svelte";
  import AppSessions from "./menu/AppSessions.svelte";
  import AppProblems from "./menu/AppProblems.svelte";
  import { APP_SOURCE_TEXT, appMenuSections, type AppMenuSection, type AppProblem } from "./lib/app-view";

  /**
   * One section of the app menu, over the app. The app's frame stays mounted
   * under it, so the UI keeps its state while the person reads a section.
   */
  interface Props {
    section: AppMenuSection;
    serverId: string;
    app: AppSummary;
    /** Undefined until the host answers with the state; the Secrets section needs it. */
    state: AppState | undefined;
    problems: AppProblem[];
    onClose: () => void;
  }
  let { section = $bindable(), serverId, app, state: appState, problems, onClose }: Props = $props();

  // The panel takes the keyboard when it opens, so Escape goes back to the app.
  let panelEl = $state<HTMLElement | null>(null);
  $effect(() => panelEl?.focus({ preventScroll: true }));

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  bind:this={panelEl}
  class="absolute inset-0 z-10 flex min-h-0 flex-col bg-(--solus-container-bg) outline-none"
  aria-label="App menu"
  data-testid="app-menu-panel"
  tabindex="-1"
  onkeydown={handleKeydown}
>
  <div class="flex shrink-0 items-center gap-1 border-b border-border/50 px-3 py-1.5">
    <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:h-0" role="tablist" aria-label="App menu sections">
      {#each appMenuSections(problems.length, section) as entry (entry.id)}
        {@const isActive = entry.id === section}
        <button
          type="button"
          role="tab"
          aria-selected={isActive}
          data-testid={`app-menu-tab-${entry.id}`}
          class="flex h-7 shrink-0 cursor-pointer items-center rounded-lg border-0 px-2.5 text-workspace-chrome transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-10 {isActive
            ? 'bg-[var(--wash-3)] font-medium text-foreground shadow-[inset_0_0_0_.5px_var(--hairline-strong)]'
            : 'bg-transparent font-normal text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground'}"
          onclick={() => (section = entry.id)}
        >
          {entry.label}
        </button>
      {/each}
    </div>
    <button type="button" class={PAGE_ICON_BTN} aria-label="Back to the app" title="Back to the app" data-testid="app-menu-close" onclick={onClose}>
      <CloseIcon size={16} />
    </button>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 py-3 text-sm" role="tabpanel">
    {#if section === "problems"}
      <AppProblems {problems} onOpenSection={(next) => (section = next)} />
    {:else if section === "versions"}
      <AppVersions {serverId} {app} />
    {:else if section === "schedules"}
      <AppSchedules {serverId} {app} />
    {:else if section === "secrets"}
      <AppSecrets {serverId} {app} secrets={appState?.secrets} />
    {:else if section === "webhooks"}
      <AppWebhooks {serverId} {app} />
    {:else if section === "calls"}
      <AppCalls {serverId} {app} />
    {:else if section === "sessions"}
      <AppSessions {serverId} {app} />
    {:else}
      <div class="flex flex-col gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <span class="shrink-0 text-xs text-muted-foreground">Slug</span>
          <code class="min-w-0 truncate rounded-md bg-muted/50 px-1.5 py-0.5 font-mono text-xs">{app.slug}</code>
          <CopyButton text={app.slug} title="Copy the slug" iconOnly />
        </div>
        <p class="m-0 text-sm text-muted-foreground text-pretty">{APP_SOURCE_TEXT}</p>
      </div>
    {/if}
  </div>
</section>
