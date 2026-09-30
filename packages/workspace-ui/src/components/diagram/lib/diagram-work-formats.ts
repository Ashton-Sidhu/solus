import type { DiagramDoc } from "@solus/contracts/diagram-types";
import { serializeMermaid } from "@solus/contracts/diagram-mermaid";
import { toasts } from "../../../lib/toasts";
import type { WorkCopyFormat, WorkExportFormat } from "../../work/lib/work-export";
import { dataUrlToPayload, renderDiagramPng, renderDiagramSvg, type RenderDiagramImageOptions } from "./diagram-export";

interface FormatSources {
  /** The saved `{nodes, edges}` text — the unreadable source itself when parsing failed. */
  json: () => string;
  /** The whole document, detail included. */
  doc: () => DiagramDoc;
  /** Null until the canvas is mounted. */
  image: () => RenderDiagramImageOptions | null;
}

async function png(sources: FormatSources): Promise<string | null> {
  const options = sources.image();
  return options ? renderDiagramPng(options) : null;
}

/** Every format a diagram is saved as, in the order the menu lists them. */
export function diagramExportFormats(sources: FormatSources): WorkExportFormat[] {
  return [
    {
      extension: "png",
      label: "PNG",
      mimeType: "image/png",
      produce: async () => {
        const url = await png(sources);
        return url ? dataUrlToPayload(url) : null;
      },
    },
    {
      extension: "svg",
      label: "SVG",
      mimeType: "image/svg+xml",
      produce: async () => {
        const options = sources.image();
        const url = options && (await renderDiagramSvg(options));
        return url ? dataUrlToPayload(url) : null;
      },
    },
    {
      extension: "json",
      label: "JSON",
      mimeType: "application/json",
      produce: () => ({ contents: sources.json(), encoding: "utf8" }),
    },
    {
      extension: "mmd",
      label: "Mermaid",
      mimeType: "text/vnd.mermaid",
      produce: () => ({ contents: serializeMermaid(sources.doc()), encoding: "utf8" }),
    },
  ];
}

/** JSON is the header's inline Copy verb already, so it is not repeated here. */
export function diagramCopyFormats(sources: FormatSources): WorkCopyFormat[] {
  return [
    {
      id: "image",
      label: "Image",
      copy: async () => {
        try {
          const url = await png(sources);
          if (!url) {
            toasts.info("Nothing to copy — the diagram is empty");
            return;
          }
          const blob = await (await fetch(url)).blob();
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          toasts.success("Image copied");
        } catch {
          toasts.error("Copy failed");
        }
      },
    },
    {
      id: "mermaid",
      label: "Mermaid",
      copy: async () => {
        try {
          await navigator.clipboard.writeText(serializeMermaid(sources.doc()));
          toasts.success("Mermaid copied");
        } catch {
          toasts.error("Copy failed");
        }
      },
    },
  ];
}
