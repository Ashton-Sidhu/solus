<script lang="ts">
  /** A server's logo: the catalog's icon, else the service's logo by address, else its first letter. */
  import { serverIconUrl } from "./lib/integration-labels";

  interface Props { name: string; url: string; icon?: string }
  let { name, url, icon }: Props = $props();

  let hasFailed = $state(false);
  const src = $derived(icon ?? serverIconUrl(url));
</script>

{#if hasFailed}
  <span class="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-workspace-chrome font-medium text-muted-foreground" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
{:else}
  <img {src} alt="" loading="lazy" referrerpolicy="no-referrer" onerror={() => (hasFailed = true)}
    class="size-8 shrink-0 rounded-lg border border-border bg-white object-contain p-1" />
{/if}
