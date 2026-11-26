<script lang="ts">
  /**
   * One provider in the Agents step: the 20 px mark slot, its name and one
   * line, and the 120 px trailing slot with its status or action. A sign-in
   * that waits on the browser expands under the row.
   */
  import type { Snippet } from "svelte";
  import { Check as CheckIcon, LoaderCircle as SpinnerIcon } from "@lucide/svelte";
  import type { SetupAgent } from "@solus/contracts/types";
  import { Button } from "../ui/button";
  import ProviderMark from "../ui/ProviderMark.svelte";
  import { providerMarkFor, type AgentRowTrailing } from "./lib/agent-rows";

  interface Props {
    agent: SetupAgent;
    name: string;
    detail: string;
    trailing: AgentRowTrailing;
    onaction?: () => void;
    children?: Snippet;
  }

  let { agent, name, detail, trailing, onaction, children }: Props = $props();
</script>

<div class="flex min-h-12 items-center gap-3.5">
  <span class="flex w-5 shrink-0 justify-center"><ProviderMark mark={providerMarkFor(agent)} size={16} transparent /></span>
  <div class="flex min-w-0 flex-1 flex-col gap-px">
    <span class="text-[14px] leading-5 font-medium text-(--solus-text-primary)">{name}</span>
    <span class="truncate text-[13px] leading-4.5 text-(--solus-text-tertiary)">{detail}</span>
  </div>
  <div class="flex min-w-30 shrink-0 items-center justify-end gap-1.25 text-[13px] leading-4.5 font-medium whitespace-nowrap">
    {#if trailing.kind === "action"}
      <Button variant="outline" size="sm" class="h-7.5 rounded-md px-3 text-[13px] font-medium" onclick={onaction}>{trailing.text}</Button>
    {:else if trailing.kind === "busy"}
      <SpinnerIcon size={13} class="animate-spin text-(--solus-text-tertiary) motion-reduce:animate-none" />
      <span class="text-(--solus-text-tertiary)">{trailing.text}</span>
    {:else if trailing.kind === "waiting"}
      <span class="size-1.5 rounded-full bg-(--warning)" aria-hidden="true"></span>
      <span class="text-(--solus-text-secondary)">{trailing.text}</span>
    {:else}
      <CheckIcon size={13} strokeWidth={2.8} class="text-(--solus-status-live)" />
      <span class="text-(--solus-status-live)">{trailing.text}</span>
    {/if}
  </div>
</div>
{@render children?.()}
