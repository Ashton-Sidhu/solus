<script lang="ts">
  import { GithubLogoIcon } from "phosphor-svelte";
  import type { ListSourceId } from "./list-page";

  /** The provider a row lives in, as its brand logo. A native Solus record is a
   *  quiet neutral dot rather than a badge — most rows are local, so a filled
   *  mark on every one would just be noise; the upstream providers earn the
   *  colour because they're the exception worth spotting in a scan. */
  interface Props {
    source: ListSourceId;
    title?: string;
  }
  let { source, title }: Props = $props();

  // Each brand keeps its own colour where it has one. GitHub's mark is
  // monochrome by design, so it borrows the text colour and holds in both
  // themes instead of being pinned to one background.
  const TINT: Record<Exclude<ListSourceId, "local">, string> = {
    github: "var(--foreground)",
    linear: "#5E6AD2",
    jira: "#2684FF",
  };
</script>

{#if source === "local"}
  <span
    class="size-[5px] shrink-0 rounded-full bg-[color-mix(in_oklch,var(--foreground)_26%,transparent)]"
    {title}
  ></span>
{:else}
  <span
    class="flex size-[15px] shrink-0 items-center justify-center text-[var(--tint)] {source ===
    'github'
      ? ''
      : 'rounded-[4px] bg-[color-mix(in_oklch,var(--tint)_13%,transparent)] shadow-[inset_0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent)]'}"
    style="--tint: {TINT[source]}"
    {title}
  >
    {#if source === "github"}
      <GithubLogoIcon size={11} weight="fill" />
    {:else if source === "linear"}
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path
          d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"
        />
      </svg>
    {:else}
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path
          d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z"
        />
      </svg>
    {/if}
  </span>
{/if}
