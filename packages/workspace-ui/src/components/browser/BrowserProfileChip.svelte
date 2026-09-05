<script lang="ts">
  import {
    Check,
    ChevronDown,
    CircleUserRound,
    Plus,
    Star,
    Trash2,
    Pencil,
    DownloadCloud,
  } from "@lucide/svelte";
  import {
    BROWSER_PROFILE_NAME_MAX,
    browserProfileName,
    type BrowserProfileSet,
  } from "@solus/contracts/browser-types";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import { toasts } from "../../lib/toasts";
  import * as Popover from "../ui/popover";
  import BrowserCookieImport from "./BrowserCookieImport.svelte";

  /**
   * Which signed-in identity a browser page uses, and the way to manage the set.
   *
   * A page's identity is fixed for its life (ADR 0023), so the chip states which
   * identity this page is, and the way to another one is to open the same
   * address again as that profile.
   */

  interface Props {
    set: BrowserProfileSet | null;
    /** The page's profile, or the one the next page will open as. */
    selectedId: string;
    /** Open this page's address again as another profile. Absent where there is
     *  no page to reopen. */
    onOpenAs?: ((profileId: string) => void) | undefined;
    /** The host whose profiles these are. Every mutation answers with the whole
     *  set and the host broadcasts the same set, so every client lands on one list. */
    serverId: string;
    projectRoot: string | undefined;
  }

  let { set, selectedId, onOpenAs, serverId, projectRoot }: Props = $props();

  let open = $state(false);
  /** The popover's second view: importing is a consented, one-time act with its
   *  own explanation. */
  let importingInto = $state<string | null>(null);
  /** Which row is being renamed, or `""` while a new profile is being named. */
  let naming = $state<string | null>(null);
  let draftName = $state("");
  /** Arms the destructive row: the second press is the confirmation. */
  let deleteArmedFor = $state<string | null>(null);

  const profiles = $derived(set?.profiles ?? []);
  const label = $derived(browserProfileName(set, selectedId));

  function failed(action: string): (error: Error) => void {
    return (error) => void toasts.error(action, { description: error.message });
  }

  function beginNaming(profileId: string, current: string) {
    naming = profileId;
    draftName = current;
    deleteArmedFor = null;
  }

  function cancelNaming() {
    naming = null;
    draftName = "";
  }

  function commitNaming() {
    const name = draftName.trim();
    const target = naming;
    cancelNaming();
    if (!name || target === null) return;
    if (target === "") {
      void browserStore
        .createProfile(serverId, projectRoot, name)
        .catch(failed("Couldn't create that browser profile"));
    } else {
      void browserStore
        .renameProfile(serverId, projectRoot, target, name)
        .catch(failed("Couldn't rename that browser profile"));
    }
  }

  function setDefault(profileId: string) {
    void browserStore
      .setDefaultProfile(serverId, projectRoot, profileId)
      .catch(failed("Couldn't change the default browser profile"));
  }

  function remove(profileId: string) {
    void browserStore
      .deleteProfile(serverId, projectRoot, profileId)
      .catch(failed("Couldn't delete that browser profile"));
  }

  function reset() {
    cancelNaming();
    deleteArmedFor = null;
    importingInto = null;
  }
</script>

{#snippet nameField(ariaLabel: string, placeholder: string)}
  <!-- svelte-ignore a11y_autofocus -->
  <input
    class="text-workspace-chrome h-8 w-full rounded-md bg-[var(--wash-1)] px-2 text-(--solus-text-primary) shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)] outline-none"
    maxlength={BROWSER_PROFILE_NAME_MAX}
    autofocus
    {placeholder}
    aria-label={ariaLabel}
    bind:value={draftName}
    onblur={commitNaming}
    onkeydown={(event) => {
      if (event.key === "Enter") commitNaming();
      if (event.key === "Escape") cancelNaming();
    }}
  />
{/snippet}

<Popover.Root
  bind:open
  onOpenChangeComplete={(isOpen) => {
    if (!isOpen) reset();
  }}
>
  <Popover.Trigger
    class="text-workspace-chrome flex h-6.5 min-w-0 shrink-0 items-center gap-1.5 overflow-hidden rounded-full px-2.5 shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)] transition-colors {open
      ? 'bg-[var(--card)] shadow-[shadow:0_0_0_0.5px_var(--hairline-strongest)]'
      : 'hover:bg-[var(--wash-2)]'}"
    aria-label="Browser profile: {label}"
  >
    <CircleUserRound
      class="size-3 shrink-0 text-(--solus-text-tertiary)"
      aria-hidden="true"
    />
    <!-- The name gives way before the chip does: a phone pane is narrower than
         every rung the toolbar's other controls disappear at, and this is the
         only way to the profile list. -->
    <span
      class="max-w-24 truncate text-(--solus-text-primary) @max-[30rem]/toolbar:max-w-12"
      >{label}</span
    >
    <ChevronDown class="size-2.5 shrink-0 text-(--solus-text-tertiary)" />
  </Popover.Trigger>

  <Popover.Content
    side="bottom"
    align="end"
    sideOffset={6}
    class="max-h-[calc(100vh-8rem)] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto p-1.5"
    aria-label="Browser profiles"
  >
    {#if importingInto !== null}
      <BrowserCookieImport
        {serverId}
        {projectRoot}
        profileId={importingInto}
        profileName={browserProfileName(set, importingInto)}
        onBack={() => (importingInto = null)}
      />
    {:else}
      <div class="text-workspace-chrome">
        <div
          class="px-2 pt-1 pb-1.5 font-medium tracking-widest text-(--solus-text-tertiary) uppercase"
        >
          Signed in as
        </div>

        {#each profiles as profile (profile.id)}
          {@const isDefault = profile.id === set?.defaultProfileId}
          {#if naming === profile.id}
            {@render nameField(`Rename ${profile.name}`, "")}
          {:else}
            <div
              class="group/profile flex h-8 w-full items-center gap-1 rounded-md pr-1 pl-2 transition-colors hover:bg-[var(--wash-2)]"
            >
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden text-left"
                aria-pressed={profile.id === selectedId}
                disabled={!onOpenAs || profile.id === selectedId}
                title={profile.id === selectedId
                  ? `This page is signed in as ${profile.name}`
                  : `Open this address again as ${profile.name}`}
                onclick={() => {
                  onOpenAs?.(profile.id);
                  open = false;
                }}
              >
                <CircleUserRound
                  class="size-3.5 shrink-0 text-(--solus-text-tertiary)"
                />
                <span class="min-w-0 truncate text-(--solus-text-primary)"
                  >{profile.name}</span
                >
                {#if isDefault}
                  <span class="shrink-0 text-(--solus-text-tertiary)">Default</span>
                {/if}
                {#if profile.id === selectedId}
                  <Check class="size-3 shrink-0 text-[var(--primary)]" />
                {/if}
              </button>

              <!-- The row's own actions. They hold their slots at zero opacity so
                   hovering a profile never shifts the name under the pointer, and
                   focus reveals them so the keyboard reaches every one. -->
              {#if !isDefault}
                <button
                  type="button"
                  class="flex size-6 shrink-0 items-center justify-center rounded-full text-(--solus-text-tertiary) opacity-0 transition-opacity group-hover/profile:opacity-100 hover:bg-[var(--wash-3)] hover:text-(--solus-text-primary) focus-visible:opacity-100"
                  aria-label="Open new pages as {profile.name}"
                  title="Open new pages as {profile.name}"
                  onclick={() => setDefault(profile.id)}
                >
                  <Star class="size-3" />
                </button>
              {/if}
              <button
                type="button"
                class="flex size-6 shrink-0 items-center justify-center rounded-full text-(--solus-text-tertiary) opacity-0 transition-opacity group-hover/profile:opacity-100 hover:bg-[var(--wash-3)] hover:text-(--solus-text-primary) focus-visible:opacity-100"
                aria-label="Import browser cookies into {profile.name}"
                title="Import browser cookies into {profile.name}"
                onclick={() => {
                  deleteArmedFor = null;
                  importingInto = profile.id;
                }}
              >
                <DownloadCloud class="size-3" />
              </button>
              {#if !profile.builtIn}
                <button
                  type="button"
                  class="flex size-6 shrink-0 items-center justify-center rounded-full text-(--solus-text-tertiary) opacity-0 transition-opacity group-hover/profile:opacity-100 hover:bg-[var(--wash-3)] hover:text-(--solus-text-primary) focus-visible:opacity-100"
                  aria-label="Rename {profile.name}"
                  title="Rename"
                  onclick={() => beginNaming(profile.id, profile.name)}
                >
                  <Pencil class="size-3" />
                </button>
                <button
                  type="button"
                  class="flex shrink-0 items-center justify-center gap-1 rounded-full px-1.5 opacity-0 transition-opacity group-hover/profile:opacity-100 focus-visible:opacity-100 {deleteArmedFor ===
                  profile.id
                    ? 'h-6 bg-[color-mix(in_oklch,var(--failure)_14%,transparent)] text-[var(--failure)] opacity-100'
                    : 'size-6 text-(--solus-text-tertiary) hover:bg-[var(--wash-3)] hover:text-[var(--failure)]'}"
                  aria-label={deleteArmedFor === profile.id
                    ? `Confirm deleting ${profile.name} and everything it is signed in to`
                    : `Delete ${profile.name}`}
                  title={deleteArmedFor === profile.id
                    ? "This signs the profile out for good"
                    : "Delete"}
                  onclick={() => {
                    if (deleteArmedFor === profile.id) {
                      deleteArmedFor = null;
                      remove(profile.id);
                      return;
                    }
                    deleteArmedFor = profile.id;
                  }}
                >
                  <Trash2 class="size-3 shrink-0" />
                  {#if deleteArmedFor === profile.id}
                    <span>Delete</span>
                  {/if}
                </button>
              {/if}
            </div>
          {/if}
        {/each}

        <div class="my-1.5 h-px bg-[var(--hairline)]"></div>

        {#if naming === ""}
          {@render nameField("New browser profile name", "Profile name, e.g. Admin")}
        {:else}
          <button
            type="button"
            class="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-[var(--wash-2)]"
            onclick={() => beginNaming("", "")}
          >
            <Plus class="size-3.5 shrink-0 text-(--solus-text-tertiary)" />
            <span class="text-(--solus-text-primary)">New profile</span>
          </button>
        {/if}
      </div>
    {/if}
  </Popover.Content>
</Popover.Root>
