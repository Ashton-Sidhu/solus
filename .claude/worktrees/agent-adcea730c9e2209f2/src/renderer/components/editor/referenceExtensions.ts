import type { AnyExtension } from "@tiptap/core";
import { PlanRefExtension } from "./planRefExtension";
import { WorkRefExtension } from "./workRefExtension";
import { FileRefExtension } from "./fileRefExtension";
import { SlashRefExtension } from "./slashRefExtension";

// The four inline reference nodes (@file, #plan, %work, /command) that the
// reference autocomplete inserts. Shared so any editor host — the lightweight
// MarkdownEditor or the rich DocumentEditor — registers the same node schema.
export const referenceExtensions: AnyExtension[] = [
  PlanRefExtension,
  WorkRefExtension,
  FileRefExtension,
  SlashRefExtension,
];
