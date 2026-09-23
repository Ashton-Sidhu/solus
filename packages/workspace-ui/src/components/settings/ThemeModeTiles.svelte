<script lang="ts">
  /** The appearance picker: three tiles, each a miniature of the app painted
   *  in the mode it stands for. System shows both halves split down the
   *  middle. The selected tile carries a ring; the label does the rest. */
  import type { ThemeMode } from "@solus/contracts/host-config";
  import {
    DARK_PREVIEW,
    LIGHT_PREVIEW,
    THEME_MODE_TILES,
    type ThemePreviewColors,
  } from "./lib/theme-preview";

  interface Props {
    value: ThemeMode;
    onSelect: (mode: ThemeMode) => void;
  }

  let { value, onSelect }: Props = $props();
</script>

<!-- A pane is one mode's miniature: sidebar with search and thread rows, a
     conversation with a user bubble and two reply lines, the composer with its
     send orb, and the project rail floating at the right. All geometry is in
     percentages so the frame's height is the only size that matters. -->
{#snippet pane(colors: ThemePreviewColors, clip?: "left" | "right")}
  <span
    class="absolute inset-0"
    style:clip-path={clip === "left"
      ? "polygon(0 0, calc(50% - 1px) 0, calc(50% - 1px) 100%, 0 100%)"
      : clip === "right"
        ? "polygon(calc(50% + 1px) 0, 100% 0, 100% 100%, calc(50% + 1px) 100%)"
        : undefined}
  >
    <span class="absolute inset-0" style:background-color={colors.canvas}></span>
    <span
      class="absolute inset-y-0 left-0 w-[22%]"
      style:background-color={colors.sidebar}
      style:box-shadow="inset -1px 0 0 {colors.line}"
    ></span>

    <span
      class="absolute left-[3%] top-[8%] h-[8%] w-[16%] rounded-md"
      style:background-color={colors.surface}
      style:box-shadow="inset 0 0 0 1px {colors.line}"
    ></span>
    <span
      class="absolute left-[3%] top-[22%] h-[7%] w-[16%] rounded-md opacity-25"
      style:background-color={colors.accent}
    ></span>
    <span
      class="absolute left-[3%] top-[32%] h-[7%] w-[16%] rounded-md opacity-70"
      style:background-color={colors.line}
    ></span>
    <span
      class="absolute left-[3%] top-[42%] h-[7%] w-[16%] rounded-md opacity-50"
      style:background-color={colors.line}
    ></span>

    <span
      class="absolute right-[28%] top-[11%] h-[9%] w-[24%] rounded-lg"
      style:background-color={colors.surface}
      style:box-shadow="inset 0 0 0 1px {colors.line}"
    ></span>
    <span
      class="absolute left-[27%] top-[28%] h-[5%] w-[34%] rounded-sm"
      style:background-color={colors.line}
    ></span>
    <span
      class="absolute left-[27%] top-[38%] h-[5%] w-[26%] rounded-sm"
      style:background-color={colors.line}
    ></span>

    <span
      class="absolute bottom-[8%] left-[26%] right-[6%] flex h-[15%] items-center justify-between rounded-md px-[2.5%]"
      style:background-color={colors.surface}
      style:box-shadow="inset 0 0 0 1px {colors.line}"
    >
      <span
        class="block h-[26%] w-[34%] rounded-full opacity-70"
        style:background-color={colors.line}
      ></span>
      <span
        class="block aspect-square h-[58%] rounded-full"
        style:background-color={colors.accent}
      ></span>
    </span>

    <span
      class="absolute right-[5%] top-[8%] h-[46%] w-[20%] rounded-lg"
      style:background-color={colors.surface}
      style:box-shadow="inset 0 0 0 1px {colors.line}, 0 2px 5px rgb(0 0 0 / 0.14)"
    >
      {#each [0, 1, 2] as row (row)}
        <span
          class="absolute left-[11%] right-[11%] flex h-[20%] items-center gap-[5%]"
          style:top="{10 + row * 30}%"
        >
          <span
            class="block aspect-square h-[26%] rounded-full opacity-55"
            style:background-color={row === 0 ? "#34d399" : row === 1 ? colors.accent : "#fbbf24"}
          ></span>
          <span
            class="block h-[30%] w-[52%] rounded-sm"
            style:background-color={colors.line}
          ></span>
        </span>
      {/each}
    </span>
  </span>
{/snippet}

<div aria-label="Appearance mode" class="grid w-full grid-cols-3 gap-3 @max-[30rem]/pane:grid-cols-1" role="group">
  {#each THEME_MODE_TILES as tile (tile.mode)}
    {@const active = value === tile.mode}
    <button
      type="button"
      aria-label={tile.ariaLabel}
      aria-pressed={active}
      onclick={() => onSelect(tile.mode)}
      class="flex cursor-pointer flex-col items-stretch gap-2 rounded-xl border p-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring {active
        ? 'border-transparent bg-accent/30 shadow-[inset_0_0_0_1px_var(--ring)]'
        : 'border-border/70 bg-card/60 hover:bg-accent/10'}"
    >
      <!-- The miniature grows with the column rather than sitting at a fixed
           height, so three tiles across a 56rem settings column stand about
           11rem tall and read as the app in small, not as a strip. -->
      <span
        aria-hidden="true"
        class="relative block aspect-[16/10] w-full overflow-hidden rounded-lg border border-border/60"
      >
        {#if tile.mode === "system"}
          {@render pane(LIGHT_PREVIEW, "left")}
          {@render pane(DARK_PREVIEW, "right")}
        {:else}
          {@render pane(tile.mode === "dark" ? DARK_PREVIEW : LIGHT_PREVIEW)}
        {/if}
      </span>
      <span
        class="flex items-center justify-center text-sm font-medium {active
          ? 'text-foreground'
          : 'text-muted-foreground'}"
      >
        {tile.label}
      </span>
    </button>
  {/each}
</div>
