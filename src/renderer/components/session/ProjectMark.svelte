<script lang="ts">
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import { projectFallbackColor } from "../../lib/project-favicon";

  interface Props {
    /** The project's repo root — also the path the favicon is looked up under. */
    projectKey: string;
    /** 1–2 letters, shown when the project ships no favicon of its own. */
    initial: string;
    /** The project the active task belongs to states itself at full strength. */
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

  // The hue is identity, not state: one project keeps one colour wherever its
  // mark appears, so two rows are told apart before either label is read.
  // `active` spends contrast on top of that hue rather than replacing it — a
  // mark that changed colour on selection would be a different project as far
  // as the eye is concerned, which is exactly what a single brand-filled tile
  // did to every project in the band.
  const markColor = $derived(projectFallbackColor(projectKey));
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
  <!--
    A tinted plate with the letters in the project's own colour, rather than
    white letters on a solid fill. The palette runs dark in light mode and
    pastel in dark mode, so a fixed ink colour is legible in exactly one of
    them; mixing both the plate and the letters against the *current* surface
    keeps one formula correct in both. The gradient and the hairline ring are
    what give the tile an edge at 15px, where a flat rectangle reads as a gap.
  -->
  <span
    class="flex size-full items-center justify-center rounded font-semibold tracking-[-0.02em] uppercase {letterClass}"
    style:--project-mark={markColor}
    style:background="linear-gradient(180deg, color-mix(in oklch, var(--project-mark) {active
      ? 28
      : 17}%, transparent), color-mix(in oklch, var(--project-mark) {active
      ? 18
      : 10}%, transparent))"
    style:box-shadow="inset 0 0 0 0.5px color-mix(in oklch, var(--project-mark) {active
      ? 40
      : 26}%, transparent)"
    style:color="color-mix(in oklch, var(--project-mark) {active
      ? 84
      : 70}%, var(--foreground))">{initial}</span
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
