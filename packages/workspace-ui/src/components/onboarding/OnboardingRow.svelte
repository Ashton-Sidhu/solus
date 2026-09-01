<script lang="ts">
  /**
   * The one row shape the arrival stages share: a tinted mark, a name and a
   * detail line, and whatever the row can currently be asked to do. Agents,
   * providers and the two start choices all read as the same object so the
   * three stages stack without a seam between them.
   */
  import { Check as CheckIcon } from "@lucide/svelte";
  import type { Snippet } from "svelte";

  interface Props {
    name: string;
    detail: string;
    /** Seconds of stagger, so a list of rows arrives in sequence. */
    delay?: number;
    tint: string;
    /** Two letters for an agent, or an icon for a provider or a choice. */
    abbr?: string;
    mark?: Snippet;
    state: "available" | "busy" | "done";
    statusText?: string;
    actionLabel?: string;
    onaction?: () => void;
    /** Pressing anywhere on the row picks it — for the start-choice cards. */
    onpick?: () => void;
    /** Anything the row expands into: a device code, a token field, an error. */
    expansion?: Snippet;
    /**
     * Whether the expansion has anything in it. A snippet is truthy whether or
     * not it renders, so without this the row grows an empty ruled strip the
     * moment a caller passes one at all.
     */
    expanded?: boolean;
  }

  let {
    name,
    detail,
    delay = 0,
    tint,
    abbr,
    mark,
    state,
    statusText,
    actionLabel,
    onaction,
    onpick,
    expansion,
    expanded = false,
  }: Props = $props();
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<svelte:element
  this={onpick ? "button" : "div"}
  type={onpick ? "button" : undefined}
  onclick={onpick}
  class="text-xs onboarding-enter relative flex w-full flex-col overflow-hidden rounded-2xl bg-[var(--wash-1)] text-left transition-colors duration-150 hover:bg-[var(--wash-2)]"
  class:cursor-pointer={!!onpick}
  style="animation-delay: {delay}s"
>
  <div class="flex min-h-[4.5rem] items-center gap-3 py-3 pl-4 pr-4 sm:gap-4 sm:pr-5">
    <span
      class="flex size-10 shrink-0 items-center justify-center rounded-full  font-medium transition-colors duration-150"
      style="background: color-mix(in oklch, {tint} 16%, transparent); color: color-mix(in oklch, {tint} 72%, var(--foreground))"
    >
      {#if mark}{@render mark()}{:else}{abbr}{/if}
    </span>

    <span class="flex min-w-0 flex-col gap-1">
      <span class="text-sm font-medium ">{name}</span>
      <span
        class="truncate text-sm text-muted-foreground"
        >{detail}</span
      >
    </span>

    <span class="ml-auto flex shrink-0 items-center pl-3">
      {#if state === "done"}
        <span
          class="flex size-[1.125rem] items-center justify-center rounded-full"
          style="color: color-mix(in oklch, var(--success) 58%, var(--foreground))"
        >
          <CheckIcon size={13} weight="bold" />
        </span>
      {:else if state === "busy"}
        <span class="text-muted-foreground">
          {statusText}
        </span>
      {:else if actionLabel}
        <button
          type="button"
          class="h-7 shrink-0 rounded-full bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-[filter,transform] duration-150 hover:brightness-[1.06] active:scale-[0.96]"
          onclick={(event) => {
            event.stopPropagation();
            onaction?.();
          }}
        >
          {actionLabel}
        </button>
      {:else if statusText}
        <span class="text-muted-foreground">
          {statusText}
        </span>
      {/if}
    </span>
  </div>

  {#if expansion && expanded}
    <div class="border-t border-(--hairline) px-4 pb-4 pt-3.5">
      {@render expansion()}
    </div>
  {/if}

  <!-- An install or a sign-in has no percentage to report, so the row draws an
       indeterminate sweep rather than inventing progress it cannot measure. The
       bar has a fixed width and is translated across its clip: animating `left`
       and `width` instead relayouts the row on every frame. -->
  {#if state === "busy"}
    <span class="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden" aria-hidden="true">
      <span
        class="block h-full w-2/5 rounded-full bg-primary"
        style="animation: onboarding-sweep 1.15s cubic-bezier(0.65, 0, 0.35, 1) infinite"
      ></span>
    </span>
  {/if}
</svelte:element>
