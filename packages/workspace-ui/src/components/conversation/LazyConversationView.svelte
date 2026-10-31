<script lang="ts">
  import type { ComponentProps } from "svelte";
  import ConversationSkeleton from "./ConversationSkeleton.svelte";
  import RouteLoadError from "../ui/RouteLoadError.svelte";
  import { loadConversationView } from "./lib/conversation-view-loader";

  let props: ComponentProps<(typeof import("./ConversationView.svelte"))["default"]> = $props();
  let attempt = $state(0);
</script>

{#key attempt}
{#await loadConversationView()}
  <ConversationSkeleton />
{:then module}
  {@const ConversationView = module.default}
  <ConversationView {...props} />
{:catch error}
  <RouteLoadError {error} compact onRetry={() => (attempt += 1)} />
{/await}
{/key}
