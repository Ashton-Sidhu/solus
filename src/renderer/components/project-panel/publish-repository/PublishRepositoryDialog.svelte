<script lang="ts">
  import { GithubLogoIcon, CircleNotchIcon, XIcon } from "phosphor-svelte";
  import {
    getSessionEnvironmentStore,
    getWorkspaceContext,
    runtime,
  } from "../../../contexts";
  import { serverConnections } from "@client-core/server-connections";
  import type { GithubPublishRepositoryRequest } from "../../../../shared/types";
  import { repositorySetupStore } from "../../../contexts/git/repository-setup.store.svelte";
  import { toasts } from "../../../lib/toasts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import { Switch } from "../../ui/switch";
  import GithubConnectionRequired from "../../prs/GithubConnectionRequired.svelte";
  import { getPopoverLayer } from "../../popoverLayer.svelte";
  import { portal } from "../../portal";
  import {
    centringPadding,
    observeConversationBounds,
    type ConversationBounds,
  } from "../../pickers/lib/conversation-bounds";
  import {
    publishFailureMessage,
    publishFailureStage,
    publishRepositoryUrl,
  } from "../lib/git-setup";
  import { repoNameFromPath } from "../../servers/lib/clone-url";

  interface Props {
    /** The tab or draft whose project this dialog publishes — see `GitSection`. */
    sourceId: string;
    onClose: () => void;
  }
  let { sourceId, onClose }: Props = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();
  const api = $derived(session.apiFor(sourceId));
  const serverId = $derived(serverConnections.serverIdForApi(api));
  const env = $derived(
    environmentStore.environmentFor(session.runFor(sourceId)),
  );
  const cwd = $derived(env.cwd);
  const ctx = $derived(
    session.ctxForEnvironment(env.cwd, env.checkout, sourceId),
  );

  // Same centring contract as the commit composer: the dialog belongs to the
  // conversation it was opened from, so it centres on that column rather than
  // the window, and portals to the app-root layer to stay viewport-anchored.
  const layer = getPopoverLayer();
  let viewportWidth = $state(0);
  let conversationBounds = $state<ConversationBounds | null>(null);
  const centringStyle = $derived(
    runtime.isMobileViewport
      ? ""
      : centringPadding(conversationBounds, viewportWidth),
  );
  $effect(() =>
    observeConversationBounds((bounds) => (conversationBounds = bounds)),
  );

  const githubConnected = $derived(
    repositorySetupStore.githubConnectedFor(serverId, cwd),
  );
  const publishing = $derived(repositorySetupStore.isPublishing(serverId, cwd));
  const publishError = $derived(
    repositorySetupStore.publishErrorFor(serverId, cwd),
  );
  const lastResult = $derived(
    repositorySetupStore.lastPublishResultFor(serverId, cwd),
  );
  const lastFailureMessage = $derived(
    lastResult ? publishFailureMessage(lastResult) : null,
  );
  const lastRepositoryUrl = $derived(
    lastResult ? publishRepositoryUrl(lastResult) : null,
  );
  const lastFailureStage = $derived(
    lastResult ? publishFailureStage(lastResult) : null,
  );

  let owner = $state("");
  let name = $state("");
  let isPrivate = $state(true);
  let useSsh = $state(false);

  // The project folder names the repository, so the form opens ready to submit.
  // Owner is left blank on purpose: empty means "my account", which the host
  // resolves from the credential the checkout actually publishes with — for a
  // dispatched session that is the device that dispatched it, not the host.
  let prefilled = false;
  $effect(() => {
    if (prefilled || !api || !cwd || cwd === "~" || githubConnected === false) return;
    prefilled = true;
    name = repoNameFromPath(cwd);
  });

  async function submit() {
    if (!api || !name.trim() || publishing) return;
    const request: GithubPublishRepositoryRequest = {
      name: name.trim(),
      private: isPrivate,
      protocol: useSsh ? "ssh" : "https",
    };
    const organization = owner.trim();
    if (organization) request.owner = organization;
    const result = await repositorySetupStore.publish(api, serverId, ctx, cwd, request);
    if (result?.success) {
      toasts.success("Published to GitHub");
      await environmentStore
        .refreshEnvironment(session, { sourceId, cwd, level: "details" })
        .catch(() => null);
      onClose();
      return;
    }
    if (!result) {
      toasts.error("Couldn't publish to GitHub", {
        description: publishError ?? undefined,
      });
    }
  }

  function openRepositoryUrl(url: string) {
    void api.openExternal(url);
    requestInputFocus();
  }

  function onPanelKeydown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!publishing) onClose();
    }
  }
</script>

<svelte:window bind:innerWidth={viewportWidth} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
{#if layer.el}
  <div
    use:portal={layer.el}
    data-solus-ui
    class="fixed inset-0 z-[10008] flex items-center justify-center overflow-hidden overscroll-contain pointer-events-auto bg-[color-mix(in_srgb,var(--solus-modal-scrim)_55%,transparent)] [animation:publish-repository-backdrop-in_160ms_ease_both]"
    style={centringStyle}
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget && !publishing) onClose();
    }}
    onkeydown={onPanelKeydown}
  >
    <div
      class="flex max-h-[min(38rem,80svh)] w-[clamp(20rem,40vw,26rem)] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl max-md:max-h-[88svh] max-md:w-[calc(100vw-1.5rem)] max-md:max-w-none border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14)] [.dark_&]:shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.06)] outline-none [animation:publish-repository-enter_200ms_cubic-bezier(0.22,1,0.36,1)_backwards]"
      role="dialog"
      aria-label="Publish to GitHub"
      aria-modal="true"
    >
      <div
        class="relative flex h-[2.875rem] flex-shrink-0 items-center gap-2 px-[1.125rem] after:absolute after:bottom-0 after:left-[1.125rem] after:right-[1.125rem] after:h-[0.0625rem] after:bg-(--solus-popover-border) after:opacity-[0.35] after:content-['']"
      >
        <GithubLogoIcon
          size={14}
          weight="fill"
          class="flex-shrink-0 text-(--solus-accent)"
        />
        <span class="text-workspace-chrome font-medium text-(--solus-text-primary)"
          >Publish to GitHub</span
        >
        <button
          type="button"
          class="relative ml-auto inline-flex size-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-lg border-none bg-transparent text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] disabled:opacity-50 after:absolute after:-inset-1.5 after:content-[''] max-md:after:-inset-2.5"
          onclick={onClose}
          disabled={publishing}
          aria-label="Close"
        >
          <XIcon size={14} />
        </button>
      </div>

      {#if githubConnected === false}
        <div class="px-[1.125rem] py-4">
          <GithubConnectionRequired {serverId} layout="stacked" />
        </div>
      {:else}
        <div class="flex flex-col gap-2 overflow-y-auto px-[1.125rem] py-3">
          {#if lastResult && !lastResult.success}
            <p
              class="text-pretty text-xs leading-relaxed text-(--solus-status-error)"
            >
              {lastFailureStage === "repository"
                ? "Couldn't create the repository"
                : lastFailureStage === "remote"
                  ? "Repository created, but adding the remote failed"
                  : "Repository created, but the push failed"}{lastFailureMessage
                ? `: ${lastFailureMessage}`
                : "."}
            </p>
            {#if lastRepositoryUrl}
              <button
                type="button"
                class="truncate text-left text-xs text-(--solus-accent) hover:underline"
                onclick={() => openRepositoryUrl(lastRepositoryUrl)}
              >
                {lastRepositoryUrl}
              </button>
            {/if}
          {/if}
          <label class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground max-md:text-xs"
              >Organization <span class="opacity-60">(optional)</span></span
            >
            <Input
              bind:value={owner}
              class="h-7 text-xs max-md:h-11 max-md:text-base"
              placeholder="Your account"
              spellcheck={false}
              autocomplete="off"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground max-md:text-xs"
              >Repository name</span
            >
            <Input
              bind:value={name}
              autofocus
              class="h-7 text-xs max-md:h-11 max-md:text-base"
              spellcheck={false}
              autocomplete="off"
            />
          </label>
          <div class="flex items-center justify-between gap-2 py-0.5 max-md:py-2">
            <span class="text-xs text-muted-foreground max-md:text-sm">Private repository</span
            >
            <Switch
              checked={isPrivate}
              onCheckedChange={(next) => (isPrivate = next)}
              size="default"
              class="max-md:after:-inset-y-4"
              aria-label="Private repository"
            />
          </div>
          <div class="flex items-center justify-between gap-2 py-0.5 max-md:py-2">
            <span class="text-xs text-muted-foreground max-md:text-sm">Use SSH</span>
            <Switch
              checked={useSsh}
              onCheckedChange={(next) => (useSsh = next)}
              size="default"
              class="max-md:after:-inset-y-4"
              aria-label="Publish over SSH"
            />
          </div>
          {#if publishError}
            <p
              class="text-pretty text-xs leading-relaxed text-(--solus-status-error)"
            >
              {publishError}
            </p>
          {/if}
        </div>

        <div
          class="relative flex h-[3.25rem] flex-shrink-0 items-center justify-end gap-1.5 px-[1.125rem] max-md:h-auto max-md:flex-col-reverse max-md:items-stretch max-md:gap-2 max-md:py-3 before:absolute before:left-[1.125rem] before:right-[1.125rem] before:top-0 before:h-[0.0625rem] before:bg-(--solus-popover-border) before:opacity-[0.35] before:content-['']"
        >
          <Button
            variant="ghost"
            size="sm"
            class="text-workspace-chrome max-md:h-11"
            disabled={publishing}
            onclick={onClose}>Cancel</Button
          >
          <Button
            size="sm"
            class="gap-1.5 text-workspace-chrome max-md:h-11"
            disabled={publishing || !name.trim()}
            onclick={() => void submit()}
          >
            {#if publishing}
              <CircleNotchIcon
                size={14}
                class="animate-spin [animation-duration:0.7s]"
              />
            {/if}
            {publishing
              ? "Publishing…"
              : lastResult && !lastResult.success
                ? "Retry"
                : "Publish"}
          </Button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  @keyframes publish-repository-backdrop-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes publish-repository-enter {
    from {
      opacity: 0;
      transform: translate3d(0, 0.5rem, 0) scale(0.97);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
    }
  }
</style>
