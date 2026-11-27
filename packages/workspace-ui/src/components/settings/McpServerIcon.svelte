<script lang="ts">
  /**
   * A server's logo, in this order: the icon the server names in its
   * `serverInfo` (fetched by the host, with its own dark version when it has
   * one), the catalog's icon, the service's logo by address, and last its first
   * letter on a tile tinted by its name. A command (`stdio:` address, or none
   * yet) has no address to ask, so without its own icon it shows its letter.
   */
  import type { IntegrationIcon } from "@solus/contracts/integration-types";
  import { monogramHue, serverIconUrl } from "./lib/integration-labels";

  interface Props { name: string; url: string; icon?: string; serverIcon?: IntegrationIcon }
  let { name, url, icon, serverIcon }: Props = $props();

  let hasFailed = $state(false);
  const src = $derived(icon ?? serverIconUrl(url));
  const isCommand = $derived(!icon && (url === "" || url.startsWith("stdio:")));
</script>

{#if serverIcon}
  <img src={serverIcon.light} alt="" class="size-8 shrink-0 rounded-lg border border-border/50 bg-white object-contain p-1.5 shadow-xs {serverIcon.dark ? 'dark:hidden' : ''}" />
  {#if serverIcon.dark}
    <img src={serverIcon.dark} alt="" class="hidden size-8 shrink-0 rounded-lg border border-border/50 bg-card object-contain p-1.5 dark:block" />
  {/if}
{:else if isCommand || hasFailed}
  <span style="--tile-hue: {monogramHue(name)}"
    class="grid size-8 shrink-0 place-items-center rounded-lg border border-[oklch(0.88_0.05_var(--tile-hue))] bg-[oklch(0.96_0.035_var(--tile-hue))] text-[15px] font-semibold text-[oklch(0.48_0.11_var(--tile-hue))] dark:border-[oklch(0.4_0.05_var(--tile-hue))] dark:bg-[oklch(0.3_0.045_var(--tile-hue))] dark:text-[oklch(0.85_0.09_var(--tile-hue))]"
    aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
{:else}
  <img {src} alt="" loading="lazy" referrerpolicy="no-referrer" onerror={() => (hasFailed = true)}
    class="size-8 shrink-0 rounded-lg border border-border/50 bg-white object-contain p-1.5 shadow-xs" />
{/if}
