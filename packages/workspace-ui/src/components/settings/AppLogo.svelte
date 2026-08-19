<script lang="ts">
  import Icon from "@iconify/svelte";
  import { CodeIcon, TerminalWindowIcon } from "phosphor-svelte";
  import { ensureIconCollections } from "../diagram/iconify";
  import { APP_ICONS } from "./lib/app-icon-assets";
  import { appLogoFor } from "./lib/app-logos";
  import type { EditorId, TerminalAppId } from "@solus/contracts/types";

  interface Props {
    id: EditorId | TerminalAppId | null;
    /** Detected application name, for an app Solus knows only by sight. */
    name?: string;
    /** Glyph shown for an app with neither an icon nor a brand mark. */
    kind: "editor" | "terminal";
    size?: number;
  }

  let { id, name, kind, size = 14 }: Props = $props();

  ensureIconCollections();

  // The app's own icon first: it is what the user recognizes. A brand mark is
  // the stand-in for an app whose icon has not been extracted on any machine.
  const appIcon = $derived(id ? APP_ICONS.get(id) : undefined);
  const logo = $derived(appLogoFor(id, name));
</script>

{#if appIcon}
  <img
    src={appIcon}
    alt=""
    class="shrink-0 rounded-[3px]"
    style="width:{size}px;height:{size}px"
  />
{:else if logo}
  <Icon icon={logo} width={size} height={size} />
{:else if kind === "editor"}
  <CodeIcon {size} class="text-(--solus-text-tertiary)" />
{:else}
  <TerminalWindowIcon {size} class="text-(--solus-text-tertiary)" />
{/if}
