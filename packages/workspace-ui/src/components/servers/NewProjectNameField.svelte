<script lang="ts">
  /**
   * The name of a new project, typed as the last segment of its own path: the
   * host's projects folder leads in muted text and the name completes it, so
   * the field and "where it lands" are one line rather than a field and a
   * caption. When the host will rename the folder (`My Website` → `My-Website`)
   * the field says so at its end.
   *
   * With `onchangeparent`, the folder prefix is itself the control that moves
   * the project somewhere else. The size comes from the caller's text class;
   * every part inherits it.
   */
  import { safeProjectDirName } from "@solus/contracts/project-folder-name";
  import { abbreviateHome } from "../../lib/paths";
  import { joinHostPath } from "./lib/open-project-flow";

  interface Props {
    value: string;
    /** The host-absolute folder the project is created in. */
    parent: string;
    platform?: string | null;
    disabled?: boolean;
    /** Widened to what the Open project dialog focuses across its steps. */
    inputEl?: HTMLInputElement | HTMLTextAreaElement | null;
    /** Enter in the field. Omit where the surrounding surface owns Enter. */
    onsubmit?: () => void;
    /** Makes the folder prefix a button that picks another folder. */
    onchangeparent?: () => void;
    class?: string;
  }

  let {
    value = $bindable(""),
    parent,
    platform = null,
    disabled = false,
    inputEl = $bindable(null),
    onsubmit,
    onchangeparent,
    class: className = "",
  }: Props = $props();

  const prefix = $derived(abbreviateHome(joinHostPath(parent, "", platform)));
  const folderName = $derived(value.trim() ? safeProjectDirName(value) : "");
  const isRenamed = $derived(!!folderName && folderName !== value.trim());

  function onkeydown(event: KeyboardEvent) {
    if (!onsubmit || event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    onsubmit();
  }
</script>

<!-- `direction: rtl` on the prefix clips a long folder from its start, so the
     end nearest the name stays readable; `bdi` keeps the path itself LTR. -->
<span class="flex min-w-0 flex-1 items-baseline {className}">
  {#if onchangeparent}
    <button
      type="button"
      class="min-w-0 max-w-[55%] shrink overflow-hidden truncate rounded-sm text-muted-foreground [direction:rtl]
        underline-offset-4 transition-colors duration-(--duration-quick)
        hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
      title="Change location — {parent}"
      aria-label="Location {prefix}. Change location"
      onclick={onchangeparent}
    >
      <bdi>{prefix}</bdi>
    </button>
  {:else}
    <span class="min-w-0 max-w-[55%] shrink truncate text-muted-foreground [direction:rtl]" title={parent}>
      <bdi>{prefix}</bdi>
    </span>
  {/if}
  <input
    bind:this={inputEl}
    bind:value
    class="min-w-[6ch] flex-1 bg-transparent p-0 text-[length:inherit] font-medium text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground/40"
    placeholder="project-name"
    aria-label="Project name"
    spellcheck={false}
    autocomplete="off"
    autocapitalize="off"
    {disabled}
    {onkeydown}
  />
  {#if isRenamed}
    <span class="ml-2 max-w-[40%] shrink-0 truncate text-xs text-muted-foreground" title="The folder is named {folderName}">
      as {folderName}
    </span>
  {/if}
</span>
