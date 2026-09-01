<script lang="ts">
  import type { Component, Snippet } from "svelte";
  import RouteLoadError from "../ui/RouteLoadError.svelte";

  interface Props {
    load: () => Promise<{ default: Component }>;
    fallback: Snippet;
    children?: Snippet<[Component]>;
  }

  let { load, fallback, children }: Props = $props();
  let attempt = $state(0);
</script>

{#key attempt}
  {#await load()}
    {@render fallback()}
  {:then routeModule}
    {@const Route = routeModule.default}
    {#if children}
      {@render children(Route)}
    {:else}
      <Route />
    {/if}
  {:catch error}
    <RouteLoadError {error} compact onRetry={() => (attempt += 1)} />
  {/await}
{/key}
