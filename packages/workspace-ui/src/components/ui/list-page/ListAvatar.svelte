<script lang="ts">
  import solusIcon from "../../../../../../resources/icon.iconset/icon_32x32@2x.png";
  import { avatarTint, type ListPerson } from "./list-page";

  /** A person on a list row. 20px in the global list, 22px in the inbox — the
   *  inbox row is taller and its actor is the subject of the sentence, so it
   *  gets the extra space — and 19px on a board card, which sits a size below
   *  the list. The fill/text pair is one hashed tint so the same person reads
   *  the same colour across both pages. */
  interface Props {
    person: ListPerson;
    size?: 19 | 20 | 22;
  }
  let { person, size = 20 }: Props = $props();

  const tint = $derived(avatarTint(person.id));
  // Two capital letters must stay inside the circle at each size: the type
  // follows the circle, not the text rung of the row.
  const initialsSize = $derived(Math.round(size * 0.45));
</script>

<span
  class="relative flex shrink-0 items-center justify-center font-medium {person.fallback ===
 'solus'
 ? ''
 : 'rounded-full shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_10%,transparent)_inset]'}"
  style="width: {size}px; height: {size}px; font-size: {initialsSize}px; {person.fallback === 'solus'
    ? ''
    : `background: color-mix(in oklch, var(${tint}) 22%, transparent); color: color-mix(in oklch, var(${tint}) 72%, var(--foreground))`}"
  title={person.name ?? person.id}
>
  {#if person.fallback === "solus"}
    <!-- The branded mark stands for "nobody is assigned, an agent is". It is a
         glyph, not a person, so it carries none of an avatar's circle: no
         round crop and no ring.

         The source art only fills 75% of its canvas, so at `size-full` the mark
         reads a quarter smaller than the avatars beside it. Overflowing the
         cell by 4/3 cancels that padding exactly — the visible glyph lands on
         `size`, and it stays correct at every size because it is a ratio. -->
    <img src={solusIcon} alt="" class="size-[133%] shrink-0 object-contain" />
  {:else}
    <!-- The line box of a font is taller than its capitals and not even above
         and below them, so centring the line puts the letters off centre.
         The trim leaves the capitals alone as the box, as `ProjectFavicon`
         does. No letter spacing: it adds space after the last letter only,
         which moves the pair to one side. -->
    <span class="leading-none [text-box:trim-both_cap_alphabetic]">{person.initials}</span>
    {#if person.avatarUrl}
      <img
        src={person.avatarUrl}
        alt=""
        class="absolute size-full rounded-full object-cover shadow-[0_0_0_1px_rgba(0,0,0,0.1)_inset] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.1)_inset]"
        onerror={(event) => (event.currentTarget.style.display = "none")}
      />
    {/if}
  {/if}
</span>
