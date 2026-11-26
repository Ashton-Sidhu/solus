<script lang="ts">
  import {
    Cloud as CloudIcon,
    Earth as GlobeSimpleIcon,
  } from "@lucide/svelte";
  import type { HostOperatingSystem } from "@solus/contracts/types";
  import AppleLogoIcon from "../ui/AppleLogoIcon.svelte";
  import LinuxLogoIcon from "../ui/LinuxLogoIcon.svelte";
  import WindowsLogoIcon from "../ui/WindowsLogoIcon.svelte";

  /**
   * The mark for a machine you are not sitting at: its operating system's logo,
   * or a cloud for a cloud machine of an organization (docs/plans/managed-hosts.md),
   * whose operating system is nobody's concern.
   */
  interface Props {
    os?: HostOperatingSystem;
    /** A cloud machine: the cloud, whatever it runs on. */
    cloud?: boolean;
    size?: number;
    class?: string;
    /** Names the host when the mark stands alone in a row. */
    "aria-label"?: string;
  }

  let {
    os,
    cloud = false,
    size = 15,
    class: className = "",
    "aria-label": ariaLabel,
  }: Props = $props();
</script>

{#if cloud}
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
