<script lang="ts">
  import {
    AppleLogoIcon,
    GlobeSimpleIcon,
    LinuxLogoIcon,
    WindowsLogoIcon,
  } from "phosphor-svelte";
  import type { HostOperatingSystem } from "@solus/contracts/types";

  interface Props {
    os?: HostOperatingSystem;
    size?: number;
    class?: string;
    /** Names the host when the mark stands alone in a row. */
    "aria-label"?: string;
  }

  let {
    os,
    size = 15,
    class: className = "",
    "aria-label": ariaLabel,
  }: Props = $props();
</script>

{#if os === "macos"}
  <AppleLogoIcon {size} class={className} aria-label={ariaLabel} />
{:else if os === "windows"}
  <WindowsLogoIcon {size} class={className} aria-label={ariaLabel} />
{:else if os === "linux"}
  <LinuxLogoIcon {size} class={className} aria-label={ariaLabel} />
{:else}
  <GlobeSimpleIcon {size} class={className} aria-label={ariaLabel} />
{/if}
