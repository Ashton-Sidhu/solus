<script lang="ts">
  /**
   * The name of a new project, asked as a name and not as a path. One quiet
   * line under the field says what the host will make: the folder's own name
   * (`My Website` becomes `My-Website`), the folder it goes in, and the
   * machine. The full path is only a tooltip — a person who does not think in
   * paths is never asked to read one.
   *
   * With `onchangeparent`, the line ends in "Change", which picks another
   * folder. The field's text size comes from the caller's class.
   */
  import { safeProjectDirName } from "@solus/contracts/project-folder-name";
  import { folderLabel, newProjectPath } from "./lib/open-project-flow";

  interface Props {
    value: string;
    /** The host-absolute folder the project is created in. */
    parent: string;
    platform?: string | null;
    /** The machine the folder is made on. */
    hostLabel: string;
    disabled?: boolean;
    /** Widened to what the Open project dialog focuses across its steps. */
    inputEl?: HTMLInputElement | HTMLTextAreaElement | null;
    /** Enter in the field. Omit where the surrounding surface owns Enter. */
    onsubmit?: () => void;
    /** Adds "Change", which picks another folder. */
    onchangeparent?: () => void;
    /** Shows "Project name" above the field; omit where a heading asks already. */
    showsLabel?: boolean;
    class?: string;
  }

  let {
    value = $bindable(""),
    parent,
    platform = null,
    hostLabel,
    disabled = false,
    inputEl = $bindable(null),
    onsubmit,
    onchangeparent,
    showsLabel = false,
    class: className = "",
  }: Props = $props();

  const id = $props.id();
  const folderName = $derived(value.trim() ? safeProjectDirName(value) : "");
  const place = $derived(folderLabel(parent));
  const fullPath = $derived(newProjectPath(parent, value, platform) ?? parent);

  function onkeydown(event: KeyboardEvent) {
    if (!onsubmit || event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    onsubmit();
  }
</script>

<div class="flex min-w-0 flex-1 flex-col gap-1.5">
  {#if showsLabel}
    <label for="{id}-name" class="text-sm font-medium text-foreground">Project name</label>
  {/if}
  <input
    bind:this={inputEl}
    bind:value
    id="{id}-name"
    class="min-w-0 bg-transparent p-0 font-medium text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground/50 {className}"
    placeholder="My website"
    aria-label={showsLabel ? undefined : "Project name"}
    aria-describedby="{id}-location"
    spellcheck={false}
    autocomplete="off"
    {disabled}
    {onkeydown}
  />
  <p id="{id}-location" class="min-w-0 text-pretty text-xs text-muted-foreground" title={fullPath}>
    {#if folderName}
      Creates the folder <span class="font-medium text-foreground">{folderName}</span>
      in {place} on {hostLabel}.
    {:else}
      Creates a folder in {place} on {hostLabel}.
    {/if}
    {#if onchangeparent}
      <button
        type="button"
        class="rounded-sm text-foreground underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none disabled:opacity-50"
        {disabled}
        onclick={onchangeparent}
      >
        Change
      </button>
    {/if}
  </p>
</div>
