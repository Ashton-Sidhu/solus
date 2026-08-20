import { z } from "zod";

const dataUrlSchema = z.string();

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
