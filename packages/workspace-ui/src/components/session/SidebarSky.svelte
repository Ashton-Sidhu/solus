<script lang="ts">
  /** The sky behind the sidebar's title bar. One static picture for each
   *  scene of the day; it is opaque behind the title bar's controls and then
   *  thins on a long eased curve, gone at the top of the search field, so it
   *  has no lower edge and the search field stays on the plain surface. The
   *  Solus mark is the sun of every scene, so the glow and the orbit lines
   *  centre on it. Nothing here animates
   *  (docs/plans/sidebar-places-and-sky.md). */
  import { isDarkSkyScene, type SkyScene } from "../../lib/sky-scene";
  import {
    SKY_HEADER_DROP_REM,
    SKY_ORBIT_REACH,
    SKY_ORBITS,
    SKY_STARS,
  } from "./lib/sidebar-sky";

  let { scene }: { scene: SkyScene } = $props();
</script>

<div
  class="sidebar-sky pointer-events-none absolute inset-x-0 -z-1 overflow-hidden"
  data-scene={scene}
  style:--sidebar-sky-drop="{SKY_HEADER_DROP_REM}rem"
  aria-hidden="true"
>
  {#if isDarkSkyScene(scene)}
    <!-- The stars fill the band and clear away from the wordmark, so no star
         reads as punctuation. -->
    <svg class="sidebar-sky-stars absolute inset-x-0 top-0 w-full">
      {#each SKY_STARS as star (`${star.x}:${star.y}`)}
        {#if star.isBright}
          <circle
            cx="{star.x}%"
            cy="{star.y}%"
            r={star.radius * 3.2}
            fill={star.color}
            fill-opacity={star.opacity * 0.14}
          />
        {/if}
        <circle
          cx="{star.x}%"
          cy="{star.y}%"
          r={star.radius}
          fill={star.color}
          fill-opacity={star.opacity}
        />
      {/each}
    </svg>
  {:else}
    <svg
      class="sidebar-sky-orbits absolute overflow-visible"
      width={SKY_ORBIT_REACH * 2}
      height={SKY_ORBIT_REACH * 2}
      style:--sidebar-sky-orbit-reach="{SKY_ORBIT_REACH}px"
      fill="none"
      stroke="#d97757"
      stroke-linecap="round"
    >
      {#each SKY_ORBITS as orbit (orbit.radius)}
        <circle
          cx={SKY_ORBIT_REACH}
          cy={SKY_ORBIT_REACH}
          r={orbit.radius}
          stroke-opacity={orbit.opacity}
          stroke-dasharray={orbit.dashArray}
          transform="rotate({orbit.rotation} {SKY_ORBIT_REACH} {SKY_ORBIT_REACH})"
        />
      {/each}
    </svg>
  {/if}
</div>

<style>
  .sidebar-sky {
    /* The centre of the mark in the title bar: SidePanel places the brand
       1.25rem after the native window buttons, or at the header's padding,
       and the mark is 1.25rem wide (SidebarBrand). */
    --sidebar-sky-sun-x: max(
      1.25rem,
      calc(
        var(--solus-traffic-light-end) + 1.875rem -
          var(--side-panel-window-inset, 0px)
      )
    );
    --sidebar-sky-sun-y: 1.25rem;
    /* From the top of the picture to where the sidebar's content starts. */
    --sidebar-sky-bar: calc(
      var(--solus-chrome-row-h, 2.5rem) + var(--sidebar-sky-drop)
    );
    /* Where the fall ends: at the top of the search field, which is the
       first row of the content. Only the faintest trace reaches its top
       edge, so the field reads on the plain surface. */
    --sidebar-sky-foot: calc(var(--sidebar-sky-bar) + 0.5rem);
    top: 0;
    height: var(--sidebar-sky-foot);
    /* Opaque behind the title bar's controls, then a fall to nothing at the
       foot. The stops are solved so that night over the light surface gets
       lighter on a smoothstep curve: a dark sky over a light surface shows an
       edge wherever its lightness changes fast, and alpha alone is not
       lightness. The curve is flat at both ends, so the picture has no edge
       at the top of the fall or at its foot. */
    mask-image: linear-gradient(
      to bottom,
      black calc(var(--sidebar-sky-foot) * 0.297),
      rgb(0 0 0 / 0.982) calc(var(--sidebar-sky-foot) * 0.356),
      rgb(0 0 0 / 0.939) calc(var(--sidebar-sky-foot) * 0.414),
      rgb(0 0 0 / 0.873) calc(var(--sidebar-sky-foot) * 0.473),
      rgb(0 0 0 / 0.791) calc(var(--sidebar-sky-foot) * 0.532),
      rgb(0 0 0 / 0.689) calc(var(--sidebar-sky-foot) * 0.590),
      rgb(0 0 0 / 0.571) calc(var(--sidebar-sky-foot) * 0.649),
      rgb(0 0 0 / 0.444) calc(var(--sidebar-sky-foot) * 0.707),
      rgb(0 0 0 / 0.315) calc(var(--sidebar-sky-foot) * 0.766),
      rgb(0 0 0 / 0.195) calc(var(--sidebar-sky-foot) * 0.824),
      rgb(0 0 0 / 0.098) calc(var(--sidebar-sky-foot) * 0.883),
      rgb(0 0 0 / 0.028) calc(var(--sidebar-sky-foot) * 0.941),
      transparent var(--sidebar-sky-foot)
    );
  }

  /* The macOS title bar row starts at the window's top edge, above the
     panel's own inset, and the untitled header pulls the content 0.625rem up
     into it (SidePanel). The sky moves up with the row and its bar is that
     much shorter. */
  :global(html.is-mac-workspace) .sidebar-sky {
    --sidebar-sky-bar: calc(
      var(--solus-titlebar-height) - 0.625rem + var(--sidebar-sky-drop)
    );
    top: calc(0px - var(--side-panel-window-inset, 0px));
  }

  .sidebar-sky-stars {
    height: var(--sidebar-sky-bar);
    /* The field fades out above the scene's horizon, and a soft clearing
       keeps it off the lockup. */
    mask-image:
      linear-gradient(
        to bottom,
        black calc(var(--sidebar-sky-star-depth) * 0.55),
        transparent var(--sidebar-sky-star-depth)
      ),
      radial-gradient(
        2.9rem 1.05rem at calc(var(--sidebar-sky-sun-x) + 1.4rem)
          var(--sidebar-sky-sun-y),
        transparent 70%,
        black 100%
      );
    mask-composite: intersect;
  }

  .sidebar-sky-orbits {
    left: calc(var(--sidebar-sky-sun-x) - var(--sidebar-sky-orbit-reach));
    top: calc(var(--sidebar-sky-sun-y) - var(--sidebar-sky-orbit-reach));
    /* The lines start at the mark and thin out to the right. */
    mask-image: linear-gradient(
      to right,
      transparent calc(50% - 1.25rem),
      black 50%,
      transparent 100%
    );
  }

  /* Dawn and day are washes over the sidebar's surface, so they follow the
     theme. Dusk and night are opaque and stay dark in the light theme. The
     glow at the mark is light: a pale tint of the brand colour. The brand
     colour itself at this strength goes dark and muddy over the other wash. */
  .sidebar-sky[data-scene="dawn"] {
    background:
      radial-gradient(
        13.75rem calc(var(--sidebar-sky-bar) + 4rem) at var(--sidebar-sky-sun-x) 0,
        color-mix(in oklch, #eb9a78 58%, transparent),
        transparent 74%
      ),
      radial-gradient(
        17.5rem calc(var(--sidebar-sky-bar) + 4rem) at 78% -0.75rem,
        color-mix(in oklch, #d4af6a 60%, transparent),
        transparent 72%
      ),
      linear-gradient(
        to bottom,
        color-mix(in oklch, #d97757 30%, transparent),
        color-mix(in oklch, #d4af6a 20%, transparent)
      );
  }

  .sidebar-sky[data-scene="day"] {
    background:
      radial-gradient(
        12.5rem calc(var(--sidebar-sky-bar) + 3.5rem) at var(--sidebar-sky-sun-x) 0,
        color-mix(in oklch, #f6dca6 62%, transparent),
        transparent 74%
      ),
      radial-gradient(
        20rem calc(var(--sidebar-sky-bar) + 2.25rem) at 80% -0.75rem,
        color-mix(in oklch, #7fb2e5 62%, transparent),
        transparent 72%
      ),
      linear-gradient(
        to bottom,
        color-mix(in oklch, #7fb2e5 34%, transparent),
        color-mix(in oklch, #7fb2e5 12%, transparent)
      );
  }

  /* The sunset's horizon sits under the mark. It is muted, so it stays
     behind the list and does not pull the eye. Below it the colours go toward
     the sidebar's surface as the picture thins, so the fall reads as
     afterglow and not as grey in the light theme, and as no band in the
     dark theme. */
  .sidebar-sky[data-scene="dusk"] {
    /* Stars only in the dark sky above the sunset. */
    --sidebar-sky-star-depth: calc(var(--sidebar-sky-bar) * 0.32);
    background:
      radial-gradient(
        10rem calc(var(--sidebar-sky-bar) * 0.55) at var(--sidebar-sky-sun-x)
          calc(var(--sidebar-sky-bar) * 0.62),
        rgb(250 205 160 / 0.55),
        rgb(226 146 116 / 0.26) 50%,
        transparent 80%
      ),
      linear-gradient(
        to bottom,
        #120f25 0,
        #211a38 calc(var(--sidebar-sky-bar) * 0.3),
        #44284a calc(var(--sidebar-sky-bar) * 0.55),
        #85494f calc(var(--sidebar-sky-bar) * 0.78),
        #c08670 var(--sidebar-sky-bar),
        color-mix(in oklch, #dfb196 70%, var(--card)) var(--sidebar-sky-foot)
      );
  }

  /* The sky gets bluer as it thins, so the fall reads as the last light
     of the evening and not as grey. A faint band of the Milky Way crosses
     it. */
  .sidebar-sky[data-scene="night"] {
    --sidebar-sky-star-depth: calc(var(--sidebar-sky-bar) * 0.8);
    background:
      radial-gradient(
        7.5rem 2.5rem at var(--sidebar-sky-sun-x) var(--sidebar-sky-sun-y),
        rgb(150 160 255 / 0.3),
        transparent 78%
      ),
      linear-gradient(
        104deg,
        transparent 38%,
        rgb(140 150 230 / 0.08) 48%,
        rgb(190 195 255 / 0.13) 55%,
        rgb(140 150 230 / 0.07) 62%,
        transparent 74%
      ),
      linear-gradient(
        to bottom,
        #04051a 0,
        #0a0d2c calc(var(--sidebar-sky-bar) * 0.55),
        #1c2160 calc(var(--sidebar-sky-bar) * 0.95),
        #3a44a8 var(--sidebar-sky-foot)
      );
  }
</style>
