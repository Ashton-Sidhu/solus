<script lang="ts">
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";

  interface Props {
    /** The project's repo root — also the path the favicon is looked up under. */
    projectKey: string;
    /** 1–2 letters, shown when the project ships no favicon of its own. */
    initial: string;
    /** The project the active task belongs to takes the brand fill. */
    active: boolean;
    /** Box size — 15px in the rail, 19px on a group header. */
    class: string;
    letterClass: string;
  }
  let {
    projectKey,
    initial,
    active,
    class: className,
    letterClass,
  }: Props = $props();

  // `~` stands in for a session with no repo behind it, so there is no root to
  // look a favicon up in.
  const hasRoot = $derived(projectKey.startsWith("/"));
</script>

<!--
  A project's own favicon identifies it faster than any letter can, and it costs
  the column nothing: it is the project's colour, not one the sidebar assigned,
  so it never reads as the state colour the status glyphs own. The lettered mark
  is what a project without one falls back to.

  The mark is a flex item of the chip or header directly — wrapping it in a
  plain span put an inline-level box in an inline formatting context, where the
  line box's descender space pushed the mark off the label's centre.
-->
{#snippet letterMark()}
  <span
    class="flex size-full items-center justify-center rounded font-medium {letterClass}"
    style:background={active
      ? "var(--primary)"
      : "color-mix(in oklch, var(--foreground) 12%, transparent)"}
    style:color={active ? "var(--primary-foreground)" : "inherit"}>{initial}</span
  >
{/snippet}

{#if hasRoot}
  <ProjectFavicon
    projectRoot={projectKey}
    class={className}
    fallback={letterMark}
  />
{:else}
  <span class="flex shrink-0 {className}" aria-hidden="true"
    >{@render letterMark()}</span
  >
{/if}
