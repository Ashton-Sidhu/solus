// Adapted from T3 Code apps/mobile/src/features/devices/device-stream-document.ts (MIT, see UPSTREAM.md).
import type { DeviceHostSummary, DevicePlatform } from "@solus/contracts/device-types";
import { z } from "zod";

export interface DeviceStreamConfiguration {
  readonly platform: DevicePlatform;
  readonly kind: DeviceHostSummary["kind"];
  readonly colors: {
    readonly background: string;
    readonly muted: string;
  };
}

/** What the viewer script asks of the app. A stream URL is short-lived, so the script asks for one each time it dials. */
const deviceStreamMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("control") }),
  z.object({ type: z.literal("url"), requestId: z.number().int() }),
  z.object({ type: z.literal("status"), status: z.enum(["connecting", "streaming", "error"]), detail: z.string().optional() }),
]);
export type DeviceStreamMessage = z.infer<typeof deviceStreamMessageSchema>;

export function deviceStreamBaseUrl(viewerPlatform: string, target: Pick<DeviceStreamConfiguration, "platform" | "kind">, httpBase: string) {
  if (viewerPlatform !== "android") return "file:///";
  // H.264 decodes through WebCodecs, which needs a secure context. An iOS
  // Simulator streams JPEG from the host, which a synthetic https document
  // would block as mixed content on a plain-http host.
  if (target.platform === "android" || target.kind === "simlock") return "https://localhost/";
  return `${new URL(httpBase).origin}/`;
}

export function deviceStreamDocument(configuration: string, script: string) {
  const safeConfiguration = configuration.replace(/</g, "\\u003c");
  const safeScript = script.replace(/<\/script/gi, "<\\/script");
  const failure = `window.ReactNativeWebView.postMessage(JSON.stringify({type:"status",status:"error",detail:"Device viewer stopped unexpectedly."}));`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"></head><body><script>window.addEventListener("error",function(){${failure}});window.addEventListener("unhandledrejection",function(){${failure}});\n${safeScript}\ntry{SolusDeviceStream.start(${safeConfiguration});}catch(e){${failure}}</script></body></html>`;
}

export function deviceStreamMessage(data: string): DeviceStreamMessage | null {
  try {
    const parsed = deviceStreamMessageSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
