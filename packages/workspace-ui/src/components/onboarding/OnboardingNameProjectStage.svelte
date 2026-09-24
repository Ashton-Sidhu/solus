<script lang="ts">
  /**
   * "Start something new", asked as one more stage rather than handed to a
   * dialog over the workspace: the flow keeps its own shape until the project
   * exists, and ends in a draft in it with the composer focused.
   *
   * The host names the folder (`My Website` becomes `My-Website`) in the
   * person's projects folder, and runs `git init`. On a cloud host that folder
   * is their own, so the project stays theirs until they publish it.
   */
  import { onMount } from "svelte";
  import {
    CircleAlert as CircleAlertIcon,
    FolderPlus as FolderPlusIcon,
    LoaderCircle as LoaderIcon,
  } from "@lucide/svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { connectionsStore, runtime, serversStore } from "../../contexts";
  import Kbd from "../ui/Kbd.svelte";
  import NewProjectNameField from "../servers/NewProjectNameField.svelte";
  import { newProjectPath } from "../servers/lib/open-project-flow";
  import { messageFor } from "../servers/lib/setup-rpc";
  import { toasts } from "../../lib/toasts";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";

  interface Props {
    /** The host the project is created on. */
    serverId: string;
    oncreated: (project: { serverId: string; path: string }) => void;
    onskip: () => void;
  }

  let { serverId, oncreated, onskip }: Props = $props();

  let name = $state("");
  let creating = $state(false);
  // The failure is told once as a toast; the icon marks the field only until
  // the name that failed is edited.
  let createFailure = $state<{ name: string; message: string } | null>(null);
  const failure = $derived(createFailure?.name === name ? createFailure : null);
  let inputEl = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const capabilities = $derived(connectionsStore.capabilitiesFor(serverId));
  const hostLabel = $derived(
    serversStore.hostFor(serverId)?.label ?? "this machine",
  );
  const projectsRoot = $derived(
    capabilities?.projectsBaseDirectory ?? "~/projects",
  );
  const path = $derived(
    newProjectPath(projectsRoot, name, capabilities?.platform),
  );
  const canCreate = $derived(!!path && !creating && !!serverId);

  onMount(() => {
    // The preview needs the host's projects folder, which a fresh client may not have read yet.
    if (serverId && !capabilities)
      void connectionsStore.refreshCapabilities({ serverId });
    if (!runtime.shouldSuppressFocus)
      requestAnimationFrame(() => inputEl?.focus());
  });

  async function create() {
    if (!canCreate) return;
    const failedName = name;
    creating = true;
    createFailure = null;
    try {
      const result = await serverConnections
        .apiFor(serverId)
        .setupCreateProject({ name: name.trim() });
      oncreated({ serverId, path: result.path });
    } catch (err) {
      const message = messageFor(err);
      createFailure = { name: failedName, message };
      toasts.error("Could not create project", { description: message });
      creating = false;
      inputEl?.focus();
    }
  }

</script>

<div
  class="flex min-h-full flex-col items-center justify-center px-6 py-10 sm:px-10 sm:py-12"
>
  <h1
    class="onboarding-title m-0 shrink-0 text-center text-2xl font-medium leading-[1.12]"
  >
    Name your project
  </h1>
  <p
    class="onboarding-title mt-3 max-w-[40ch] shrink-0 text-center text-sm leading-[1.6] text-muted-foreground"
    style="animation-delay: 0.06s"
  >
    Solus makes an empty folder on {hostLabel}. Then tell an agent what to
    build!
  </p>

  <div
    class="mt-8 flex w-full max-w-[28.25rem] shrink-0 flex-col gap-2.5 sm:mt-10"
  >
    <label
      class="onboarding-enter flex min-h-[4.5rem] cursor-text items-center gap-3 rounded-2xl bg-[var(--solus-tx-card-bg)] py-3 pl-4 pr-4 shadow-[shadow:var(--solus-tx-card-shadow)] transition-shadow duration-150 focus-within:shadow-[shadow:var(--solus-tx-card-shadow-hover)] sm:gap-4 sm:pr-5"
      style="animation-delay: 0.14s"
    >
      <span
        class="flex size-10 shrink-0 items-center justify-center rounded-full"
        style="background: color-mix(in oklch, var(--chart-2) 16%, transparent); color: color-mix(in oklch, var(--chart-2) 72%, var(--foreground))"
      >
        <FolderPlusIcon size={18} />
      </span>
      <NewProjectNameField
        bind:value={name}
        bind:inputEl
        parent={projectsRoot}
        platform={capabilities?.platform}
        disabled={creating}
        onsubmit={() => void create()}
        class="text-base"
      />
      {#if creating}
        <LoaderIcon
          size={15}
          class="shrink-0 animate-spin text-muted-foreground"
          aria-label="Creating"
        />
      {:else if failure}
        <span class="shrink-0 text-(--solus-status-error)" title={failure.message}>
          <CircleAlertIcon size={15} aria-label="Could not create project" />
        </span>
      {:else if path}
        <Kbd variant="hint" class="shrink-0 pointer-coarse:hidden">↵</Kbd>
      {/if}
    </label>
  </div>

  <OnboardingStageActions
    continueLabel={creating ? "Creating…" : "Create project"}
    continueEnabled={canCreate}
    oncontinue={() => void create()}
    onback={() => store.back()}
    {onskip}
    skipLabel="Just chat"
  />
</div>
