import * as NodeZlib from "node:zlib";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { boundedZip } from "./boundedZip.ts";

it.each([false, true])("opens a password-protected ZIP (ZipCrypto: %s)", async (zipCrypto) => {
  const { Uint8ArrayWriter, TextReader, ZipWriter } =
    await import("@zip.js/zip.js/index-native.js");
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add("public.txt", new TextReader("Public"), {
    lastModDate: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
    rawLastModDate: (44 << 25) | (12 << 21) | (3 << 16) | (14 << 11) | (15 << 5) | 8,
  });
  await writer.add("secret.txt", new TextReader("Unlocked ZIP".repeat(30)), {
    password: "open me",
    zipCrypto,
  });
  const bytes = (await writer.close()).buffer;
  await expect(boundedZip(bytes)).rejects.toMatchObject({ code: "password-required" });
  await expect(boundedZip(bytes, undefined, { password: "wrong" })).rejects.toMatchObject({
    code: "password-incorrect",
  });
  const files = await boundedZip(bytes, undefined, { password: "open me" });
  expect(new TextDecoder().decode(files.get("public.txt")?.bytes)).toBe("Public");
  expect(files.get("public.txt")?.date.toISOString()).toBe("2024-12-03T14:15:16.000Z");
  expect(new TextDecoder().decode(files.get("secret.txt")?.bytes)).toBe("Unlocked ZIP".repeat(30));
  await expect(boundedZip(bytes, 50, { password: "open me" })).rejects.toMatchObject({
    code: "archive-expanded-too-large",
  });
});

it("rejects an encrypted ZIP whose Unicode path field exceeds the filename limit", async () => {
  const { Uint8ArrayWriter, TextReader, ZipWriter } =
    await import("@zip.js/zip.js/index-native.js");
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
    useUnicodeFileNames: false,
  });
  const fallback = "name.txt";
  const name = new TextEncoder().encode("a".repeat(1025));
  const unicodePath = new Uint8Array(5 + name.length);
  unicodePath[0] = 1;
  new DataView(unicodePath.buffer).setUint32(1, NodeZlib.crc32(fallback), true);
  unicodePath.set(name, 5);
  await writer.add(fallback, new TextReader("Locked"), {
    password: "open me",
    extraField: new Map([[0x7075, unicodePath]]),
  });
  const bytes = (await writer.close()).buffer;
  await expect(boundedZip(bytes, undefined, { password: "open me" })).rejects.toMatchObject({
    code: "archive-path-too-long",
  });
});
