import { z } from "zod";

const dataUrlSchema = z.string();

/** Pull image files out of a paste/drop DataTransfer. */
export function imageFilesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const files: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length === 0 && dt.files) {
    for (const f of Array.from(dt.files)) {
      if (f.type.startsWith("image/")) files.push(f);
    }
  }
  return files;
}

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = dataUrlSchema.safeParse(reader.result);
      if (result.success) resolve(result.data);
      else reject(new Error("Unable to read image."));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
