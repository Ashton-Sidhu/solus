import { describe, expect, it } from "bun:test";

import { downloadFileName } from "../../apps/mobile/src/lib/attachmentDownload";

// Opening or sharing an attachment on Android copies it to a cached file with
// the attachment's name. expo-file-system leaves `[`, `]`, `|` and `^` raw in
// that file's URI, and Android's java.net.URI rejects them, so the open failed.
describe("downloadFileName", () => {
  it("names a cached copy so Android can make its file URI", () => {
    const name = downloadFileName("Report [draft] {v2} a|b^c.pdf");
    expect(name).toBe("Report _draft_ _v2_ a_b_c.pdf");
    expect(name).not.toMatch(/["<>[\]\\^`{|}]/);
  });

  it("keeps spaces, non-Latin letters and the extension, which expo-file-system encodes", () => {
    expect(downloadFileName("Résumé 2026.pdf")).toBe("Résumé 2026.pdf");
  });
});
