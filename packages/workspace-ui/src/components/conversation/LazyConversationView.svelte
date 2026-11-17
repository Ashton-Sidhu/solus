<script lang="ts">
  import type { ComponentProps } from "svelte";
  import ConversationLoading from "./ConversationLoading.svelte";
  import RouteLoadError from "../ui/RouteLoadError.svelte";
  import { loadConversationView } from "./lib/conversation-view-loader";

  let props: ComponentProps<(typeof import("./ConversationView.svelte"))["default"]> = $props();
  let attempt = $state(0);
</script>

{#key attempt}
{#await loadConversationView()}
  <ConversationLoading />
{:then module}
  {@const ConversationView = module.default}
  <ConversationView {...props} />
{:catch error}
  <RouteLoadError {error} compact onRetry={() => (attempt += 1)} />
{/await}
{/key}
