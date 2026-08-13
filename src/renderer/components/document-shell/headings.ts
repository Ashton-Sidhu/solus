import type { Editor } from "@tiptap/core";

export interface PlanHeading {
  level: number;
  text: string;
  pos: number;
}

export function extractHeadings(editor: Editor): PlanHeading[] {
  const result: PlanHeading[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      result.push({
        level: Number(node.attrs.level),
        text: node.textContent,
        pos,
      });
    }
  });
  return result[0]?.level === 1 ? result.slice(1) : result;
}

/** The numeral each outline row hangs, parallel to `headings`.
 *
 *  Only sections — level 2 — are numbered, and they have to read the same as
 *  the numeral hanging beside that heading in the text, which comes from a CSS
 *  `counter(doc-section, decimal-leading-zero)` over every h2 in the document.
 *  Anything deeper is inside a section, so it carries no number. */
export function sectionNumbers(headings: PlanHeading[]): (string | null)[] {
  let section = 0;
  return headings.map((h) => {
    if (h.level !== 2) return null;
    section += 1;
    return String(section).padStart(2, "0");
  });
}
