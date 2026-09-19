<script lang="ts">
  import {
    Cloud as CloudIcon,
    Earth as GlobeSimpleIcon,
    Terminal as LinuxLogoIcon,
    PanelsTopLeft as WindowsLogoIcon,
  } from "@lucide/svelte";
  import type { HostOperatingSystem } from "@solus/contracts/types";
  import AppleLogoIcon from "./AppleLogoIcon.svelte";

  /**
   * The mark for a machine you are not sitting at: its operating system's logo,
   * or a cloud for a host Solus cloud runs (docs/plans/managed-hosts.md), whose
   * operating system is nobody's concern.
   */
  interface Props {
    os?: HostOperatingSystem;
    /** A managed host: the cloud, whatever it runs on. */
    managed?: boolean;
    size?: number;
    class?: string;
    /** Names the host when the mark stands alone in a row. */
    "aria-label"?: string;
  }

  let {
    os,
    managed = false,
    size = 15,
    class: className = "",
    "aria-label": ariaLabel,
  }: Props = $props();
</script>

{#if managed}
  <CloudIcon {size} class={className} aria-label={ariaLabel} />
{:else if os === "macos"}
  <AppleLogoIcon
    {size}
    class={className}
    aria-label={ariaLabel}
  />
{:else if os === "windows"}
  <WindowsLogoIcon {size} class={className} aria-label={ariaLabel} />
{:else if os === "linux"}
  <LinuxLogoIcon {size} class={className} aria-label={ariaLabel} />
{:else}
  <GlobeSimpleIcon {size} class={className} aria-label={ariaLabel} />
{/if}
