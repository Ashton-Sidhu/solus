<script lang="ts">
  import {
    AppleLogoIcon,
    GlobeSimpleIcon,
    LinuxLogoIcon,
    WindowsLogoIcon,
  } from "phosphor-svelte";
  import type { HostOperatingSystem } from "../../../shared/types";

  interface Props {
    os?: HostOperatingSystem;
    size?: number;
    class?: string;
  }

  let { os, size = 15, class: className = "" }: Props = $props();
</script>

{#if os === "macos"}
  <AppleLogoIcon {size} class={className} />
{:else if os === "windows"}
  <WindowsLogoIcon {size} class={className} />
{:else if os === "linux"}
  <LinuxLogoIcon {size} class={className} />
{:else}
  <GlobeSimpleIcon {size} class={className} />
{/if}
