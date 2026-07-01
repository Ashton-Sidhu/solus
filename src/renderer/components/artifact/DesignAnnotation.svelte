<script lang="ts">
  import { uuid } from "../../../shared/uuid";
  import {
    XIcon,
    CheckIcon,
    RectangleIcon,
    ArrowRightIcon,
    HashIcon,
    TextTIcon,
    EraserIcon,
    ArrowCounterClockwiseIcon,
    ArrowClockwiseIcon,
  } from "phosphor-svelte";
  import { portal } from "../portal";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import type { DesignAnnotation } from "../../../shared/types";

  interface Props {
    screenshotDataUrl: string;
    onConfirm: (dataUrl: string, annotations: DesignAnnotation[]) => void;
    onCancel: () => void;
  }

  let { screenshotDataUrl, onConfirm, onCancel }: Props = $props();

  type Tool = "rectangle" | "arrow" | "pin" | "text" | "eraser";
  let activeTool = $state<Tool | null>("rectangle");
  let annotations = $state<DesignAnnotation[]>([]);
  let pinCounter = $state(1);

  type HistoryEntry = { annotations: DesignAnnotation[]; pinCounter: number };
  let undoStack = $state<HistoryEntry[]>([]);
  let redoStack = $state<HistoryEntry[]>([]);

  function pushHistory() {
    undoStack = [...undoStack, { annotations: [...annotations], pinCounter }];
    redoStack = [];
  }

  function undo() {
    if (undoStack.length === 0) return;
    redoStack = [...redoStack, { annotations: [...annotations], pinCounter }];
    const prev = undoStack[undoStack.length - 1];
    undoStack = undoStack.slice(0, -1);
    annotations = [...prev.annotations];
    pinCounter = prev.pinCounter;
  }

  function redo() {
    if (redoStack.length === 0) return;
    undoStack = [...undoStack, { annotations: [...annotations], pinCounter }];
    const next = redoStack[redoStack.length - 1];
    redoStack = redoStack.slice(0, -1);
    annotations = [...next.annotations];
    pinCounter = next.pinCounter;
  }

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let imgEl: HTMLImageElement | null = $state(null);
  let containerEl: HTMLDivElement | null = $state(null);
  let isDrawing = $state(false);
  let drawStart = $state<{ x: number; y: number } | null>(null);
  let drawCurrent = $state<{ x: number; y: number } | null>(null);

  let textInputPos = $state<{ x: number; y: number } | null>(null);
  let textInputValue = $state("");
  let textInputEl: HTMLInputElement | null = $state(null);

  let imgNatW = $state(0);
  let imgNatH = $state(0);
  let imgDispW = $state(0);
  let imgDispH = $state(0);
  let imgOffX = $state(0);
  let imgOffY = $state(0);

  function nextId(): string {
    return uuid().slice(0, 8);
  }

  function toNorm(clientX: number, clientY: number): { x: number; y: number } {
    return {
      x: Math.max(0, Math.min(1, (clientX - imgOffX) / imgDispW)),
      y: Math.max(0, Math.min(1, (clientY - imgOffY) / imgDispH)),
    };
  }

  function onImgLoad() {
    if (!imgEl || !containerEl) return;
    imgNatW = imgEl.naturalWidth;
    imgNatH = imgEl.naturalHeight;
    recalcLayout();
  }

  function recalcLayout() {
    if (!imgEl || !containerEl) return;
    const rect = imgEl.getBoundingClientRect();
    imgDispW = rect.width;
    imgDispH = rect.height;
    imgOffX = rect.left;
    imgOffY = rect.top;
  }

  $effect(() => {
    const handler = () => recalcLayout();
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  });

  $effect(() => {
    if (imgEl && containerEl) {
      requestAnimationFrame(recalcLayout);
    }
  });

  function handlePointerDown(e: PointerEvent) {
    if (!activeTool) return;
    if (activeTool === "text") {
      const norm = toNorm(e.clientX, e.clientY);
      textInputPos = { x: e.clientX, y: e.clientY };
      textInputValue = "";
      setTimeout(() => textInputEl?.focus(), 50);
      return;
    }

    if (activeTool === "pin") {
      const norm = toNorm(e.clientX, e.clientY);
      pushHistory();
      annotations = [
        ...annotations,
        {
          id: nextId(),
          type: "pin",
          x: norm.x,
          y: norm.y,
          label: String(pinCounter),
        },
      ];
      pinCounter++;
      return;
    }

    if (activeTool === "eraser") {
      const norm = toNorm(e.clientX, e.clientY);

      function hits(a: DesignAnnotation): boolean {
        if (a.type === "rectangle") {
          const x1 = a.x,
            y1 = a.y;
          const x2 = a.x + (a.width ?? 0),
            y2 = a.y + (a.height ?? 0);
          // Accept clicks within `pad` of any edge so thin outlines are still reachable.
          const pad = 0.015;
          const inX = norm.x >= x1 - pad && norm.x <= x2 + pad;
          const inY = norm.y >= y1 - pad && norm.y <= y2 + pad;
          if (!inX || !inY) return false;
          if (norm.x >= x1 && norm.x <= x2 && norm.y >= y1 && norm.y <= y2)
            return true;
          const nearLeft =
            Math.abs(norm.x - x1) < pad &&
            norm.y >= y1 - pad &&
            norm.y <= y2 + pad;
          const nearRight =
            Math.abs(norm.x - x2) < pad &&
            norm.y >= y1 - pad &&
            norm.y <= y2 + pad;
          const nearTop =
            Math.abs(norm.y - y1) < pad &&
            norm.x >= x1 - pad &&
            norm.x <= x2 + pad;
          const nearBottom =
            Math.abs(norm.y - y2) < pad &&
            norm.x >= x1 - pad &&
            norm.x <= x2 + pad;
          return nearLeft || nearRight || nearTop || nearBottom;
        } else if (a.type === "arrow") {
          // Closest point on segment, then threshold the distance.
          const x1 = a.x,
            y1 = a.y,
            x2 = a.endX ?? a.x,
            y2 = a.endY ?? a.y;
          const dx = x2 - x1,
            dy = y2 - y1;
          const lenSq = dx * dx + dy * dy;
          let t =
            lenSq > 0 ? ((norm.x - x1) * dx + (norm.y - y1) * dy) / lenSq : 0;
          t = Math.max(0, Math.min(1, t));
          const nearX = x1 + t * dx,
            nearY = y1 + t * dy;
          return Math.hypot(norm.x - nearX, norm.y - nearY) < 0.025;
        } else if (a.type === "pin") {
          return Math.hypot(norm.x - a.x, norm.y - a.y) < 0.03;
        } else if (a.type === "text") {
          const charW = 0.007,
            h = 0.03,
            pad = 0.01;
          const w = (a.label?.length ?? 0) * charW + pad * 2;
          return (
            norm.x >= a.x - pad &&
            norm.x <= a.x + w &&
            norm.y >= a.y - h - pad &&
            norm.y <= a.y + pad
          );
        }
        return false;
      }

      // Erase the topmost (last-drawn) hit so overlapping annotations peel off one at a time.
      let hitIdx = -1;
      for (let i = annotations.length - 1; i >= 0; i--) {
        if (hits(annotations[i])) {
          hitIdx = i;
          break;
        }
      }
      if (hitIdx >= 0) {
        pushHistory();
        annotations = annotations.filter((_, i) => i !== hitIdx);
      }
      return;
    }

    isDrawing = true;
    drawStart = toNorm(e.clientX, e.clientY);
    drawCurrent = drawStart;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    if (!isDrawing || !drawStart) return;
    drawCurrent = toNorm(e.clientX, e.clientY);
  }

  function handlePointerUp(_e: PointerEvent) {
    if (!isDrawing || !drawStart || !drawCurrent) {
      isDrawing = false;
      return;
    }

    const dx = Math.abs(drawCurrent.x - drawStart.x);
    const dy = Math.abs(drawCurrent.y - drawStart.y);

    // Treat sub-1% drags as stray clicks so the canvas doesn't fill with dot-sized shapes.
    if (dx < 0.01 && dy < 0.01) {
      isDrawing = false;
      drawStart = null;
      drawCurrent = null;
      return;
    }

    if (activeTool === "rectangle") {
      pushHistory();
      annotations = [
        ...annotations,
        {
          id: nextId(),
          type: "rectangle",
          x: Math.min(drawStart.x, drawCurrent.x),
          y: Math.min(drawStart.y, drawCurrent.y),
          width: dx,
          height: dy,
        },
      ];
    } else if (activeTool === "arrow") {
      pushHistory();
      annotations = [
        ...annotations,
        {
          id: nextId(),
          type: "arrow",
          x: drawStart.x,
          y: drawStart.y,
          endX: drawCurrent.x,
          endY: drawCurrent.y,
        },
      ];
    }

    isDrawing = false;
    drawStart = null;
    drawCurrent = null;
  }

  function submitTextAnnotation() {
    if (!textInputPos || !textInputValue.trim()) {
      textInputPos = null;
      textInputValue = "";
      return;
    }
    const norm = toNorm(textInputPos.x, textInputPos.y);
    pushHistory();
    annotations = [
      ...annotations,
      {
        id: nextId(),
        type: "text",
        x: norm.x,
        y: norm.y,
        label: textInputValue.trim(),
      },
    ];
    textInputPos = null;
    textInputValue = "";
  }

  useScope("design-annotation", { exclusive: true });

  useKeybinding("annotation.cancel", () => {
    if (textInputPos) { textInputPos = null; textInputValue = ""; }
    else onCancel();
  });
  useKeybinding("annotation.confirm", () => handleConfirm(), { enabled: () => !textInputPos });
  useKeybinding("annotation.undo",    () => undo());
  useKeybinding("annotation.redo",    () => redo());
  useKeybinding("annotation.tool-rect",   () => { activeTool = "rectangle"; }, { enabled: () => !textInputPos });
  useKeybinding("annotation.tool-arrow",  () => { activeTool = "arrow"; },    { enabled: () => !textInputPos });
  useKeybinding("annotation.tool-pin",    () => { activeTool = "pin"; },      { enabled: () => !textInputPos });
  useKeybinding("annotation.tool-text",   () => { activeTool = "text"; },     { enabled: () => !textInputPos });
  useKeybinding("annotation.tool-eraser", () => { activeTool = "eraser"; },   { enabled: () => !textInputPos });

  async function handleConfirm() {
    if (!imgEl) return;

    // Flatten the screenshot + annotations into a single PNG at the native resolution of the screenshot.
    const canvas = document.createElement("canvas");
    canvas.width = imgNatW;
    canvas.height = imgNatH;
    const ctx = canvas.getContext("2d")!;

    ctx.drawImage(imgEl, 0, 0, imgNatW, imgNatH);

    const scaleX = imgNatW;
    const scaleY = imgNatH;

    for (const a of annotations) {
      if (a.type === "rectangle") {
        ctx.fillStyle = "rgba(217, 119, 87, 0.07)";
        ctx.strokeStyle = "#d97757";
        ctx.lineWidth = Math.max(2.5, imgNatW * 0.002);
        ctx.setLineDash([]);
        const rx = a.x * scaleX,
          ry = a.y * scaleY;
        const rw = (a.width ?? 0) * scaleX,
          rh = (a.height ?? 0) * scaleY;
        ctx.beginPath();
        ctx.roundRect(rx, ry, rw, rh, 3);
        ctx.fill();
        ctx.stroke();
      } else if (a.type === "arrow") {
        ctx.strokeStyle = "#d97757";
        ctx.fillStyle = "#d97757";
        ctx.lineWidth = Math.max(2.5, imgNatW * 0.002);
        ctx.setLineDash([]);
        ctx.lineCap = "round";
        const x1 = a.x * scaleX,
          y1 = a.y * scaleY;
        const x2 = (a.endX ?? a.x) * scaleX,
          y2 = (a.endY ?? a.y) * scaleY;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const headLen = Math.max(14, imgNatW * 0.009);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(
          x2 - headLen * Math.cos(angle - Math.PI / 6),
          y2 - headLen * Math.sin(angle - Math.PI / 6),
        );
        ctx.lineTo(
          x2 - headLen * Math.cos(angle + Math.PI / 6),
          y2 - headLen * Math.sin(angle + Math.PI / 6),
        );
        ctx.closePath();
        ctx.fill();
      } else if (a.type === "pin") {
        const px = a.x * scaleX,
          py = a.y * scaleY;
        const radius = Math.max(16, imgNatW * 0.012);
        // Dark halo keeps the pin legible on any background.
        ctx.fillStyle = "rgba(28, 26, 24, 0.85)";
        ctx.beginPath();
        ctx.arc(px, py, radius + 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#d97757";
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = `700 ${Math.round(radius * 1.1)}px -apple-system, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(a.label ?? "", px, py);
      } else if (a.type === "text") {
        const px = a.x * scaleX,
          py = a.y * scaleY;
        const fontSize = Math.max(16, imgNatW * 0.012);
        ctx.font = `400 ${fontSize}px -apple-system, sans-serif`;
        const metrics = ctx.measureText(a.label ?? "");
        const padH = fontSize * 0.55;
        const padV = fontSize * 0.38;
        const stripeW = Math.max(4, fontSize * 0.18);
        const bgW = metrics.width + padH * 2 + stripeW;
        const bgH = fontSize + padV * 2;
        const bx = px;
        const by = py - bgH - fontSize * 0.15;
        const brad = fontSize * 0.35;
        ctx.fillStyle = "rgba(28, 26, 24, 0.95)";
        ctx.beginPath();
        ctx.roundRect(bx, by, bgW, bgH, brad);
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.fillStyle = "#d97757";
        ctx.beginPath();
        ctx.roundRect(bx, by + brad * 0.6, stripeW, bgH - brad * 1.2, [
          stripeW / 2,
          0,
          0,
          stripeW / 2,
        ]);
        ctx.fill();
        ctx.fillStyle = "#ccc9c0";
        ctx.font = `400 ${fontSize}px -apple-system, sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(a.label ?? "", bx + stripeW + padH, by + bgH / 2);
      }
    }

    const dataUrl = canvas.toDataURL("image/png");
    onConfirm(dataUrl, $state.snapshot(annotations));
  }

  const toolDefs: Array<{ id: Tool; icon: any; label: string; key: string }> = [
    { id: "rectangle", icon: RectangleIcon, label: "Rectangle", key: "1" },
    { id: "arrow", icon: ArrowRightIcon, label: "Arrow", key: "2" },
    { id: "pin", icon: HashIcon, label: "Marker", key: "3" },
    { id: "text", icon: TextTIcon, label: "Text", key: "4" },
    { id: "eraser", icon: EraserIcon, label: "Eraser", key: "5" },
  ];
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  data-solus-ui
  use:portal={document.body}
  bind:this={containerEl}
  style="position:fixed;inset:0;z-index:10000;background:#000;cursor:{activeTool
    ? 'crosshair'
    : 'default'}"
  onpointerdown={handlePointerDown}
  onpointermove={handlePointerMove}
  onpointerup={handlePointerUp}
>
  <img
    bind:this={imgEl}
    src={screenshotDataUrl}
    alt="Screenshot for annotation"
    onload={onImgLoad}
    style="position:absolute;inset:0;width:100%;height:100%;object-fit:fill;user-select:none;pointer-events:none"
    draggable="false"
  />

  <div
    onpointerdown={(e) => e.stopPropagation()}
    style="position:absolute;left:1rem;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;gap:0.25rem;padding:0.5rem;border-radius:1rem;background:var(--solus-popover-bg);border:0.0625rem solid var(--solus-container-border);box-shadow:var(--solus-popover-shadow);backdrop-filter:blur(1.25rem);-webkit-backdrop-filter:blur(1.25rem);z-index:2"
  >
    {#each toolDefs as tool}
      <button
        onclick={() => (activeTool = activeTool === tool.id ? null : tool.id)}
        title="{tool.label} ({tool.key})"
        style="position:relative;display:flex;align-items:center;justify-content:center;width:2.25rem;height:2.25rem;border-radius:0.625rem;border:none;cursor:pointer;transition:background 0.12s,color 0.12s;background:{activeTool === tool.id ? 'var(--solus-accent-soft)' : 'transparent'};color:{activeTool === tool.id ? 'var(--solus-accent)' : 'var(--solus-text-tertiary)'};"
      >
        <tool.icon size={16} />
        <span
          style="position:absolute;bottom:0.1875rem;right:0.25rem;font-size:0.5rem;font-family:ui-monospace,monospace;font-weight:500;line-height:1;color:{activeTool === tool.id ? 'var(--solus-accent)' : 'var(--solus-text-tertiary)'};opacity:0.55">{tool.key}</span
        >
      </button>
    {/each}

    <div
      style="width:1.25rem;height:0.0625rem;margin:0.25rem 0;background:var(--solus-container-border)"
    ></div>

    <button
      onclick={undo}
      disabled={undoStack.length === 0}
      title="Undo (U)"
      style="position:relative;display:flex;align-items:center;justify-content:center;width:2.25rem;height:2.25rem;border-radius:0.625rem;border:none;cursor:{undoStack.length === 0 ? 'default' : 'pointer'};background:transparent;color:var(--solus-text-tertiary);opacity:{undoStack.length === 0 ? 0.55 : 1};"
    >
      <ArrowCounterClockwiseIcon size={16} />
      <span
        style="position:absolute;bottom:0.1875rem;right:0.25rem;font-size:0.5rem;font-family:ui-monospace,monospace;font-weight:500;line-height:1;color:var(--solus-text-tertiary);opacity:0.55"
        >U</span
      >
    </button>

    <button
      onclick={redo}
      disabled={redoStack.length === 0}
      title="Redo (R)"
      style="position:relative;display:flex;align-items:center;justify-content:center;width:2.25rem;height:2.25rem;border-radius:0.625rem;border:none;cursor:{redoStack.length === 0 ? 'default' : 'pointer'};background:transparent;color:var(--solus-text-tertiary);opacity:{redoStack.length === 0 ? 0.55 : 1};"
    >
      <ArrowClockwiseIcon size={16} />
      <span
        style="position:absolute;bottom:0.1875rem;right:0.25rem;font-size:0.5rem;font-family:ui-monospace,monospace;font-weight:500;line-height:1;color:var(--solus-text-tertiary);opacity:0.55"
        >R</span
      >
    </button>

    <div
      style="width:1.25rem;height:0.0625rem;margin:0.25rem 0;background:var(--solus-container-border)"
    ></div>

    {#if annotations.length > 0}
      <span
        class="text-(--solus-text-tertiary)"
        style="font-size:0.6875rem;font-weight:600;font-family:-apple-system,sans-serif;padding:0.125rem 0"
        >{annotations.length}</span
      >
      <div
        style="width:1.25rem;height:0.0625rem;margin:0.25rem 0;background:var(--solus-container-border)"
      ></div>
    {/if}

    <button
      onclick={handleConfirm}
      title="Add to chat (⌘↩)"
      class="bg-(--solus-send-bg) text-(--solus-text-on-accent)"
      style="display:flex;align-items:center;justify-content:center;width:2.25rem;height:2.25rem;border-radius:0.625rem;border:none;cursor:pointer;"
    >
      <CheckIcon size={16} />
    </button>

    <button
      onclick={onCancel}
      title="Cancel (Esc)"
      class="text-(--solus-text-secondary)"
      style="display:flex;align-items:center;justify-content:center;width:2.25rem;height:2.25rem;border-radius:0.625rem;border:none;cursor:pointer;background:transparent;"
    >
      <XIcon size={16} />
    </button>
  </div>

  {#if imgDispW > 0 && imgDispH > 0}
    <svg
      style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none"
      viewBox="0 0 {imgDispW} {imgDispH}"
    >
      {#each annotations as a}
        {#if a.type === "rectangle"}
          <rect
            x={a.x * imgDispW}
            y={a.y * imgDispH}
            width={(a.width ?? 0) * imgDispW}
            height={(a.height ?? 0) * imgDispH}
            fill="rgba(217, 119, 87, 0.07)"
            stroke="#d97757"
            stroke-width="2"
            rx="3"
          />
        {:else if a.type === "arrow"}
          <line
            x1={a.x * imgDispW}
            y1={a.y * imgDispH}
            x2={(a.endX ?? a.x) * imgDispW}
            y2={(a.endY ?? a.y) * imgDispH}
            stroke="#d97757"
            stroke-width="2"
            stroke-linecap="round"
            marker-end="url(#arrowhead)"
          />
        {:else if a.type === "pin"}
          <circle
            cx={a.x * imgDispW}
            cy={a.y * imgDispH}
            r="16"
            fill="rgba(28,26,24,0.80)"
          />
          <circle
            cx={a.x * imgDispW}
            cy={a.y * imgDispH}
            r="13"
            fill="#d97757"
          />
          <text
            x={a.x * imgDispW}
            y={a.y * imgDispH}
            text-anchor="middle"
            dominant-baseline="central"
            fill="#ffffff"
            font-size="11"
            font-weight="700"
            font-family="-apple-system, sans-serif"
          >
            {a.label}
          </text>
        {:else if a.type === "text"}
          {@const charW = 11}
          {@const padH = 13}
          {@const stripeW = 4}
          {@const lw = (a.label?.length ?? 0) * charW + padH * 2 + stripeW}
          {@const lh = 42}
          {@const lx = a.x * imgDispW}
          {@const ly = a.y * imgDispH - lh - 4}
          <rect
            x={lx}
            y={ly}
            width={lw}
            height={lh}
            rx="6"
            fill="var(--solus-container-bg)"
          />
          <rect
            x={lx}
            y={ly}
            width={lw}
            height={lh}
            rx="6"
            fill="none"
            stroke="var(--solus-tool-border)"
            stroke-width="1"
          />
          <rect
            x={lx}
            y={ly + 6}
            width={stripeW}
            height={lh - 12}
            rx="1.5"
            fill="var(--solus-accent)"
          />
          <text
            x={lx + stripeW + padH}
            y={ly + lh / 2}
            dominant-baseline="central"
            fill="var(--solus-text-primary)"
            font-size="16"
            font-weight="400"
            font-family="-apple-system, BlinkMacSystemFont, sans-serif"
          >
            {a.label}
          </text>
        {/if}
      {/each}

      {#if isDrawing && drawStart && drawCurrent}
        {#if activeTool === "rectangle"}
          <rect
            x={Math.min(drawStart.x, drawCurrent.x) * imgDispW}
            y={Math.min(drawStart.y, drawCurrent.y) * imgDispH}
            width={Math.abs(drawCurrent.x - drawStart.x) * imgDispW}
            height={Math.abs(drawCurrent.y - drawStart.y) * imgDispH}
            fill="rgba(217, 119, 87, 0.05)"
            stroke="#d97757"
            stroke-width="2"
            stroke-dasharray="6 3"
            rx="3"
          />
        {:else if activeTool === "arrow"}
          <line
            x1={drawStart.x * imgDispW}
            y1={drawStart.y * imgDispH}
            x2={drawCurrent.x * imgDispW}
            y2={drawCurrent.y * imgDispH}
            stroke="#d97757"
            stroke-width="2"
            stroke-dasharray="6 3"
            stroke-linecap="round"
            marker-end="url(#arrowhead)"
          />
        {/if}
      {/if}

      <defs>
        <marker
          id="arrowhead"
          markerWidth="10"
          markerHeight="8"
          refX="9"
          refY="4"
          orient="auto"
        >
          <polygon points="0 0, 10 4, 0 8" fill="var(--solus-accent)" />
        </marker>
      </defs>
    </svg>
  {/if}

  {#if textInputPos}
    <input
      bind:this={textInputEl}
      bind:value={textInputValue}
      onpointerdown={(e) => e.stopPropagation()}
      style="position:fixed;left:{textInputPos.x}px;top:{textInputPos.y}px;background:var(--solus-container-bg);backdrop-filter:blur(1.25rem);-webkit-backdrop-filter:blur(1.25rem);color:var(--solus-text-primary);border:0.0625rem solid var(--solus-tool-border);border-left:0.1875rem solid var(--solus-accent);border-radius:0.5rem;padding:0.5rem 0.875rem 0.5rem 0.75rem;font-size:0.9375rem;outline:none;z-index:10001;min-width:28.125rem;box-shadow:var(--solus-container-shadow)"
      placeholder="Type annotation…"
      onkeydown={(e) => {
        if (e.key === "Enter") {
          e.stopPropagation();
          submitTextAnnotation();
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          textInputPos = null;
          textInputValue = "";
        }
      }}
    />
  {/if}
</div>
