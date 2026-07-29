import type { WorkStorage } from "../../../../shared/types";

/** Where the document lives, for the header's mono breadcrumb.
 *
 *  Only project-stored works have somewhere above them worth naming — a local
 *  work is just itself, and an empty breadcrumb is better than a fake one. */
export function workBreadcrumb(storage: WorkStorage | undefined): string | undefined {
  if (storage?.kind !== "project") return undefined;
  const container =
    storage.projectRoot?.replace(/\/+$/, "").split("/").pop() ||
    storage.relativePath.split("/").slice(0, -1).pop();
  return container || undefined;
}
