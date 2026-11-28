<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { CircleHelp, LoaderCircle, Maximize, Minus, Plus, X } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import * as Popover from "../ui/popover";
  import FleetMapScene from "./FleetMapScene.svelte";
  import type { FoundMachine } from "./lib/discover";
  import { machinesByZone, OPEN_ZONE_CARDS, type AddWay, type FleetMachine, type FleetZoneId, type TileColorMode, type ZoneAnswers } from "./lib/fleet-model";
  import { arrowDirection, nextFleetStop, type FleetStop } from "./lib/fleet-keys";
  import { introduceAction, introduceBlock, reachNeighbors, type IntroduceAction, type ReachEdge } from "./lib/fleet-reach";
  import type { WireRoute } from "./lib/fleet-routes";
  import { dragCurve, dragHint, dragStart, snapPoint } from "./lib/fleet-drag";
  import { cardCenter, fleetScene, zoneTop } from "./lib/fleet-scene";
  import { anchorView, centerOn, fitView, frameHeight, panView, revealRect, toScene, zoomView, type FleetView, type ScenePoint, type SceneRect } from "./lib/fleet-view";

  /**
   * The frame of the host map: it lays the map out at its own width, fits it, and
   * lets the person pan (drag the background), zoom (pinch, Ctrl or ⌘ with the
   * wheel, the buttons, or + − 0), select several hosts (Shift with a click or a
   * drag), and drag a host's handle onto another to introduce them. Arrow keys
   * move between hosts; the map is one Tab stop.
   */
  interface Props {
    machines: FleetMachine[];
    found: FoundMachine[];
    answers: ZoneAnswers;
    colorMode: TileColorMode;
    query: string;
    isLive: boolean;
    edges: ReachEdge[];
    pointedId: string | null;
    selectedId: string | null;
    pickedIds: ReadonlySet<string>;
    selectedEdgeId: string | null;
    routesOf: (serverId: string) => readonly WireRoute[];
    /** Whether this device is the local owner of a host, so it may introduce it. */
    isOwner: (serverId: string) => boolean;
    onPoint: (serverId: string | null) => void;
    /** A click or Enter on a host: Shift adds it to the picked hosts. */
    onActivate: (serverId: string, isAdding: boolean) => void;
    onSelect: (serverId: string | null) => void;
    onPick: (serverIds: string[]) => void;
    onClearSelection: () => void;
    onSelectEdge: (edgeId: string) => void;
    onOpenZone: (zone: FleetZoneId) => void;
    onAdd: (way: AddWay) => void;
    /** A drop on a found machine: add it. */
    onAddFound: (key: string) => void;
    onStart: (serverId: string) => void;
    onPointFound: (key: string | null) => void;
    onRetry: (zone: FleetZoneId) => void;
    onIntroduce: (sourceId: string, targetIds: string[], skipped: string[]) => void;
    /** The introduction a drop started, while it runs: its hosts stay marked, and the map says so. */
    introducing: { sourceId: string; targetIds: readonly string[] } | null;
    /** A click on a handle without a drag: the host's menu, which can introduce it from the keyboard too. */
    onOpenMenu: (serverId: string, x: number, y: number) => void;
  }

  let {
    machines, found, answers, colorMode, query, isLive, edges, pointedId, selectedId, pickedIds, selectedEdgeId, routesOf, isOwner,
    onPoint, onActivate, onSelect, onPick, onClearSelection, onSelectEdge, onOpenZone, onAdd, onAddFound, onStart, onPointFound, onRetry, onIntroduce, onOpenMenu, introducing,
  }: Props = $props();

  let frame = $state<HTMLDivElement | null>(null);
  let frameWidth = $state(0);
  let remPx = $state(16);
  const openZones = new SvelteSet<FleetZoneId>();
  /** A view the person set by hand; null fits the map. Fit (0) returns to null. */
  let manual = $state<FleetView | null>(null);
  let lastFocusedId = $state<string | null>(null);
  let notice = $state<string | null>(null);
  /** The view eases to a place the person asked for (a button, a key, Find, a zone); it follows a drag or a wheel at once. */
  let isGliding = $state(false);
  let gesture = $state<
    | { kind: "pan"; startX: number; startY: number; startView: FleetView; moved: boolean }
    | { kind: "box"; startX: number; startY: number; x: number; y: number }
    | {
        kind: "link"
        sourceId: string
        startX: number
        startY: number
        /** The box of the host it started from, and the side its handle is on, on the map in its px. */
        sourceRect: SceneRect
        handleSide: "left" | "bottom"
        /** The pointer on the map, in its px; `at` is the pointer in the frame, for the label. */
        to: ScenePoint
        at: ScenePoint
        overId: string | null
        overFoundKey: string | null
        /** The box of the host or found machine a drop would act on; null over nothing. */
        targetRect: SceneRect | null
        moved: boolean
      }
    | null
  >(null);

  const byZone = $derived(machinesByZone(machines));
  const byId = $derived(new Map(machines.map((machine) => [machine.serverId, machine])));
  const scene = $derived(fleetScene({ byZone, found, widthRem: frameWidth / remPx, answers, open: openZones, edges, routesOf }));
  const sceneSize = $derived({ w: frameWidth, h: scene.map.height * remPx });
  const frameSize = $derived({ w: frameWidth, h: frameHeight(sceneSize.h) });
  const view = $derived(manual ?? fitView(sceneSize, frameSize));
  const focusId = $derived(pointedId ?? selectedId);
  // While a handle is dragged, every host is a place to drop it, so none steps back. The pointer is
  // captured then, so the host it started from would otherwise stay the one in focus.
  const lit = $derived(gesture?.kind !== "link" && focusId ? new Set([focusId, ...reachNeighbors(edges, focusId)]) : null);
  const isLit = (serverId: string) => !lit || lit.has(serverId);
  const device = $derived(machines.find((machine) => machine.zone === "device") ?? null);
  const currentId = $derived(selectedId ?? lastFocusedId ?? device?.serverId ?? machines[0]?.serverId ?? null);
  const blockOf = (serverId: string) => {
    const machine = byId.get(serverId);
    return machine ? introduceBlock(machine, isOwner(serverId)) : "This host is not on the map.";
  };
  const labelOf = (serverId: string) => byId.get(serverId)?.label ?? serverId;
  const dropAction = $derived.by((): IntroduceAction | null => {
    if (gesture?.kind !== "link" || !gesture.overId) return null;
    return introduceAction({ sourceId: gesture.sourceId, dropId: gesture.overId, selected: pickedIds, edges, blockOf, labelOf });
  });
  /** Each host a drop would introduce shows it, so a drop on one of several picked hosts lights them all; a refused drop marks only the host under the pointer. */
  const dropStateOf = (serverId: string) => {
    if (introducing) return introducing.targetIds.includes(serverId) ? "ok" : null;
    if (gesture?.kind !== "link" || !dropAction) return null;
    if (dropAction.kind === "introduce") return dropAction.targetIds.includes(serverId) ? "ok" : null;
    return gesture.overId === serverId ? "no" : null;
  };
  /** The found machine a dragged handle is over: a drop there adds it. */
  const dropFoundKey = $derived(gesture?.kind === "link" ? gesture.overFoundKey : null);
  /** The line a dragged handle draws, the end it snaps to, and what a drop there would do. */
  const drag = $derived.by(() => {
    if (gesture?.kind !== "link" || !gesture.moved) return null;
    const overFoundKey = gesture.overFoundKey;
    const foundName = overFoundKey ? found.find((machine) => machine.key === overFoundKey)?.name ?? null : null;
    const target = gesture.targetRect;
    const toward = target ? { x: target.x + target.w / 2, y: target.y + target.h / 2 } : gesture.to;
    const start = dragStart(gesture.sourceRect, gesture.handleSide, toward);
    const snap = target ? snapPoint(start.point, target) : null;
    const end = snap?.point ?? gesture.to;
    return {
      d: dragCurve(start.point, start.normal, end, snap?.normal ?? null),
      from: start.point,
      end,
      isSnapped: snap !== null,
      at: gesture.at,
      // Near the right edge of the frame the label goes to the left of the pointer.
      isLabelLeft: gesture.at.x > frameSize.w - 240,
      hint: dragHint({ action: dropAction, foundName, labelOf }),
    };
  });
  const dragColor = { ok: "var(--success)", no: "var(--solus-status-error)", none: "var(--foreground)" };

  // The root size can change with the person's zoom; it is read with the frame's width.
  $effect(() => {
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => {
      frameWidth = entry?.contentRect.width ?? 0;
      remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    });
    observer.observe(frame);
    // React's and Svelte's wheel listeners are passive, so the zoom gesture listens here to keep the page from zooming.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomAt(Math.exp(-event.deltaY * 0.01), event);
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      observer.disconnect();
      frame?.removeEventListener("wheel", onWheel);
    };
  });

  function framePoint(event: { clientX: number; clientY: number }): ScenePoint {
    const box = frame?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  }

  function zoomAt(factor: number, at?: { clientX: number; clientY: number }) {
    const anchor = at ? framePoint(at) : { x: frameSize.w / 2, y: frameSize.h / 2 };
    isGliding = !at;
    manual = zoomView(view, factor, anchor);
  }

  function fit() {
    isGliding = true;
    manual = null;
  }

  /** Opens or folds a full zone in place; its top stays where it is on screen. */
  function toggleZone(zoneId: FleetZoneId) {
    const before = zoneTop(scene.map, zoneId, sceneSize);
    const next = new Set(openZones);
    if (next.has(zoneId)) next.delete(zoneId);
    else next.add(zoneId);
    const after = fleetScene({ byZone, found, widthRem: frameWidth / remPx, answers, open: next, edges, routesOf });
    isGliding = false;
    manual = anchorView(view, before, zoneTop(after.map, zoneId, { w: frameWidth, h: after.map.height * remPx }));
    if (openZones.has(zoneId)) openZones.delete(zoneId);
    else openZones.add(zoneId);
  }

  /**
   * Goes to a host that Find named: a host folded into tiles opens its zone in
   * place, the map centers it at a scale it can be read at, and it is selected.
   * A host past the cards an open zone shows opens the zone's page.
   */
  export function goTo(serverId: string): void {
    const machine = byId.get(serverId);
    if (!machine) return;
    if (machine.zone !== "device") {
      const index = byZone[machine.zone].findIndex((entry) => entry.serverId === serverId);
      if (index >= OPEN_ZONE_CARDS) {
        onOpenZone(machine.zone);
        return;
      }
      if (!scene.map.zones.find((zone) => zone.zone.id === machine.zone)?.rows.length) openZones.add(machine.zone);
    }
    const next = fleetScene({ byZone, found, widthRem: frameWidth / remPx, answers, open: openZones, edges, routesOf });
    const size = { w: frameWidth, h: next.map.height * remPx };
    const point = machine.zone === "device" ? { x: (next.map.hub.x / 100) * size.w, y: (next.map.hub.y / 100) * size.h } : cardCenter(next.map, serverId, size);
    isGliding = true;
    if (point) manual = centerOn(view, point, { w: frameWidth, h: frameHeight(size.h) });
    onSelect(serverId);
  }

  /** Each host as it is drawn, in frame px, for the arrow keys and the selection box. */
  function stops(): Array<FleetStop & { element: HTMLElement }> {
    const box = frame?.getBoundingClientRect();
    if (!frame || !box) return [];
    return [...frame.querySelectorAll<HTMLElement>("[data-host-id]")].flatMap((element) => {
      const id = element.dataset.hostId;
      const target = element.matches("[data-fleet-stop]") ? element : element.querySelector<HTMLElement>("[data-fleet-stop]");
      if (!id || !target) return [];
      const rect = element.getBoundingClientRect();
      return [{ id, x: rect.left - box.left, y: rect.top - box.top, w: rect.width, h: rect.height, element: target }];
    });
  }

  function hostIdOf(element: Element | null): string | null {
    return element?.closest<HTMLElement>("[data-host-id]")?.dataset.hostId ?? null;
  }

  function onKeyDown(event: KeyboardEvent) {
    const direction = arrowDirection(event.key);
    if (direction) {
      event.preventDefault();
      const all = stops();
      const nextId = nextFleetStop(all, hostIdOf(document.activeElement) ?? currentId, direction);
      const next = all.find((stop) => stop.id === nextId);
      if (!next) return;
      next.element.focus({ preventScroll: true });
      // A host panned out of view comes into it; one in view moves nothing.
      const topLeft = toScene(view, { x: next.x, y: next.y });
      isGliding = true;
      manual = revealRect(view, { ...topLeft, w: next.w / view.scale, h: next.h / view.scale }, frameSize);
      return;
    }
    if (event.key === " ") {
      const id = hostIdOf(document.activeElement);
      if (!id) return;
      // Space picks the host for an introduction to several; Enter still selects it.
      event.preventDefault();
      onActivate(id, true);
      return;
    }
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === "+" || event.key === "=") zoomAt(1.25);
    else if (event.key === "-") zoomAt(0.8);
    else if (event.key === "0") fit();
    else if (event.key === "Escape") {
      notice = null;
      onClearSelection();
    } else return;
    event.preventDefault();
  }

  function onPointerDown(event: PointerEvent) {
    // One pointer owns a gesture, and a control's own click is never a pan.
    if (event.button !== 0 || gesture || (event.target instanceof Element && event.target.closest("button, a, [role=button], input"))) return;
    frame?.setPointerCapture(event.pointerId);
    const at = framePoint(event);
    isGliding = false;
    gesture = event.shiftKey
      ? { kind: "box", startX: at.x, startY: at.y, x: at.x, y: at.y }
      : { kind: "pan", startX: at.x, startY: at.y, startView: view, moved: false };
  }

  function onPointerMove(event: PointerEvent) {
    if (!gesture) return;
    const at = framePoint(event);
    if (gesture.kind === "pan") {
      const moved = gesture.moved || Math.hypot(at.x - gesture.startX, at.y - gesture.startY) > 3;
      gesture = { ...gesture, moved };
      if (moved) manual = panView(gesture.startView, at.x - gesture.startX, at.y - gesture.startY);
    } else if (gesture.kind === "box") {
      gesture = { ...gesture, x: at.x, y: at.y };
    } else {
      const moved = gesture.moved || Math.hypot(at.x - gesture.startX, at.y - gesture.startY) > 4;
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const hostElement = under?.closest<HTMLElement>("[data-host-id]") ?? null;
      const overId = hostElement?.dataset.hostId ?? null;
      const isOverSource = overId === gesture.sourceId;
      // A found machine is not a host yet: a drop on it adds it.
      const foundElement = overId ? null : under?.closest<HTMLElement>("[data-found-key]") ?? null;
      const target = isOverSource ? null : hostElement ?? foundElement;
      gesture = {
        ...gesture,
        moved,
        to: toScene(view, at),
        at,
        overId: isOverSource ? null : overId,
        overFoundKey: foundElement?.dataset.foundKey ?? null,
        targetRect: target ? sceneRectOf(target) : null,
      };
    }
  }

  function onPointerUp(event: PointerEvent) {
    const done = gesture;
    gesture = null;
    if (!done) return;
    if (done.kind === "pan") {
      // A click on the background clears the selection.
      if (!done.moved) onClearSelection();
    } else if (done.kind === "box") {
      const left = Math.min(done.startX, done.x);
      const top = Math.min(done.startY, done.y);
      const right = Math.max(done.startX, done.x);
      const bottom = Math.max(done.startY, done.y);
      const inside = stops().filter((stop) => stop.x < right && stop.x + stop.w > left && stop.y < bottom && stop.y + stop.h > top).map((stop) => stop.id);
      if (inside.length) onPick(inside);
    } else if (!done.moved) {
      onOpenMenu(done.sourceId, event.clientX, event.clientY);
    } else if (done.overId) {
      const action = introduceAction({ sourceId: done.sourceId, dropId: done.overId, selected: pickedIds, edges, blockOf, labelOf });
      if (action?.kind === "introduce") {
        notice = null;
        onIntroduce(action.sourceId, action.targetIds, action.skipped);
      } else if (action) notice = action.message;
    } else if (done.overFoundKey) {
      notice = null;
      onAddFound(done.overFoundKey);
    } else {
      // A drop that lands on nothing says what it takes, so it never fails in silence.
      notice = "Drop it on another of your hosts to introduce the two, or on a found machine to add it.";
    }
  }

  /** An element's box on the map, in its px, whatever the zoom and pan. */
  function sceneRectOf(element: Element) {
    const box = element.getBoundingClientRect();
    const topLeft = toScene(view, framePoint({ clientX: box.left, clientY: box.top }));
    return { ...topLeft, w: box.width / view.scale, h: box.height / view.scale };
  }

  function onHandleDown(event: PointerEvent, serverId: string) {
    if (event.button !== 0 || gesture) return;
    event.preventDefault();
    event.stopPropagation();
    frame?.setPointerCapture(event.pointerId);
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const source = event.currentTarget.closest("[data-host-id]");
    if (!source) return;
    const at = framePoint(event);
    // A card's handle is on its left edge, This device's under it.
    const handleSide = event.currentTarget.dataset.handleSide === "bottom" ? "bottom" : "left";
    gesture = { kind: "link", sourceId: serverId, startX: at.x, startY: at.y, sourceRect: sceneRectOf(source), handleSide, to: toScene(view, at), at, overId: null, overFoundKey: null, targetRect: null, moved: false };
  }
</script>

<!-- The frame takes the map's own keys and gestures: an application role, which Svelte does not count as interactive. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={frame}
  role="application"
  aria-label="Map of your hosts"
  aria-describedby="fleet-map-keys"
  tabindex="-1"
  onkeydown={onKeyDown}
  onkeyup={(event) => {
    // A button clicks when Space is released: the keydown already picked the host.
    if (event.key === " " && hostIdOf(document.activeElement)) event.preventDefault();
  }}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={() => (gesture = null)}
  onfocusin={(event) => {
    const id = hostIdOf(event.target as Element);
    if (id) lastFocusedId = id;
  }}
  class="relative isolate touch-none overflow-hidden bg-background bg-[radial-gradient(circle,var(--hairline)_1px,transparent_1px)] [background-size:18px_18px] outline-none select-none
    {gesture?.kind === 'pan' && gesture.moved ? 'cursor-grabbing' : gesture?.kind === 'link' ? 'cursor-crosshair' : 'cursor-grab'}"
  class:paused={!isLive}
  style:height="{frameSize.h}px"
>
  <div
    class="absolute top-0 left-0 origin-top-left {isGliding && !gesture ? 'transition-transform duration-200 ease-out motion-reduce:transition-none' : ''}"
    style:width="{sceneSize.w}px"
    style:height="{sceneSize.h}px"
    style:transform="translate({view.x}px, {view.y}px) scale({view.scale})"
  >
    <FleetMapScene
      map={scene.map}
      {machines}
      {colorMode}
      {query}
      {focusId}
      {isLit}
      {selectedId}
      {pickedIds}
      {selectedEdgeId}
      {currentId}
      wires={scene.wires}
      reachPaths={scene.reachPaths}
      dragSourceId={gesture?.kind === "link" ? gesture.sourceId : introducing?.sourceId ?? null}
      {dropStateOf}
      {dropFoundKey}
      canIntroduce={(serverId) => blockOf(serverId) === null}
      {labelOf}
      {onPoint}
      onSelect={onActivate}
      {onOpenZone}
      onToggleZone={toggleZone}
      {onAdd}
      {onStart}
      {onPointFound}
      {onRetry}
      {onHandleDown}
      {onSelectEdge}
    />
    {#if drag}
      <!-- The drag line, above the cards and in the map's own px, so it never stretches or hides under a card. -->
      <svg aria-hidden="true" class="pointer-events-none absolute inset-0 z-30 overflow-visible" width={sceneSize.w} height={sceneSize.h} viewBox="0 0 {sceneSize.w} {sceneSize.h}">
        <path d={drag.d} fill="none" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke"
          stroke-dasharray={drag.hint.tone === "no" ? "6 4" : undefined} style:stroke={dragColor[drag.hint.tone]} />
        <circle cx={drag.from.x} cy={drag.from.y} r="3.5" style:fill={dragColor[drag.hint.tone]} />
        <circle cx={drag.end.x} cy={drag.end.y} r={drag.isSnapped ? 5 : 3.5} stroke-width="2" vector-effect="non-scaling-stroke"
          style:fill={drag.isSnapped ? dragColor[drag.hint.tone] : "var(--background)"} style:stroke={dragColor[drag.hint.tone]} />
      </svg>
    {/if}
  </div>

  {#if drag}
    <!-- What a drop here would do, beside the pointer. -->
    <div
      aria-live="polite"
      class="pointer-events-none absolute z-40 flex max-w-64 items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-chrome-dense whitespace-nowrap shadow-[shadow:var(--solus-menu-shadow)]
        {drag.hint.tone === 'none' ? 'text-muted-foreground' : 'text-foreground'}"
      style:left="{drag.isLabelLeft ? drag.at.x - 14 : drag.at.x + 14}px"
      style:top="{drag.at.y + 14}px"
      style:translate={drag.isLabelLeft ? "-100% 0" : undefined}
    >
      <span aria-hidden="true" class="size-1.5 shrink-0 rounded-full" style:background={dragColor[drag.hint.tone]}></span>
      <span class="truncate">{drag.hint.text}</span>
    </div>
  {/if}

  <p id="fleet-map-keys" class="sr-only">
    Arrow keys move between hosts. Enter selects a host, and Enter again opens it. Space picks hosts to introduce several at once.
    The menu key opens a host's actions, with Introduce to. Plus and minus zoom, zero fits the map, and Escape clears the selection.
  </p>

  {#if gesture?.kind === "box"}
    <div
      aria-hidden="true"
      class="pointer-events-none absolute z-30 rounded-sm border border-dashed border-foreground/50 bg-foreground/5"
      style:left="{Math.min(gesture.startX, gesture.x)}px"
      style:top="{Math.min(gesture.startY, gesture.y)}px"
      style:width="{Math.abs(gesture.x - gesture.startX)}px"
      style:height="{Math.abs(gesture.y - gesture.startY)}px"
    ></div>
  {/if}

  <!-- What a drop is doing, and why a drop did nothing, where it happened. -->
  {#if introducing}
    <div role="status" aria-busy="true" class="absolute top-3 left-1/2 z-40 flex max-w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-chrome-dense shadow-[shadow:var(--solus-menu-shadow)]">
      <LoaderCircle size={14} class="shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
      <span class="min-w-0 truncate">Introducing {labelOf(introducing.sourceId)} to {introducing.targetIds.map(labelOf).join(", ")}…</span>
    </div>
  {:else if notice}
    <div role="status" class="absolute top-3 left-1/2 z-40 flex max-w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-card py-1.5 pr-1.5 pl-3 text-chrome-dense shadow-[shadow:var(--solus-menu-shadow)]">
      <span class="min-w-0 text-pretty">{notice}</span>
      <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onclick={() => (notice = null)}><X size={14} /></Button>
    </div>
  {/if}

  <div class="absolute right-2 bottom-2 z-40 flex items-center gap-0.5 rounded-lg border border-border/60 bg-card/95 p-0.5 shadow-sm">
    <Button variant="ghost" size="icon-sm" aria-label="Zoom out" title="Zoom out (−)" onclick={() => zoomAt(0.8)}><Minus size={14} /></Button>
    <Button variant="ghost" size="icon-sm" aria-label="Zoom in" title="Zoom in (+)" onclick={() => zoomAt(1.25)}><Plus size={14} /></Button>
    <Button variant="ghost" size="icon-sm" aria-label="Fit the map to view" title="Fit (0)" onclick={fit}><Maximize size={14} /></Button>
    <Popover.Root>
      <Popover.Trigger>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="icon-sm" aria-label="How to use the map"><CircleHelp size={14} /></Button>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content side="top" align="end" class="w-72 p-3">
        <ul class="list-disc space-y-1 pl-4 text-chrome-dense text-muted-foreground">
          <li>Click a host to select it, and click it again to open it.</li>
          <li>Drag the + beside one of your hosts onto another to introduce them, so their agents reach each other. Drop it on a found machine to add that machine.</li>
          <li>Shift-click or Shift-drag to pick several hosts, then drop a + on one of them to introduce it to all.</li>
          <li>Drag the background to move the map. Pinch, or hold Ctrl or ⌘ and scroll, to zoom.</li>
          <li>Arrow keys move between hosts. Space picks, Enter selects, and the menu key opens a host's actions.</li>
        </ul>
      </Popover.Content>
    </Popover.Root>
  </div>
</div>
