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
        level: node.attrs.level as number,
        text: node.textContent,
        pos,
      });
    }
  });
  return result[0]?.level === 1 ? result.slice(1) : result;
}
