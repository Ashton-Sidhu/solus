import type { File as NativeFile } from "expo-file-system";

export async function uploadNativeAttachment(
  file: NativeFile,
  url: string,
  options: {
    signal?: AbortSignal;
    mimeType?: string;
    onProgress?: (progress: number) => void;
  },
) {
  const { UploadType } = await import("expo-file-system");
  const { signal, mimeType, onProgress } = options;
  return file.upload(url, {
    httpMethod: "POST",
    uploadType: UploadType.BINARY_CONTENT,
    signal,
    ...(mimeType && { headers: { "Content-Type": mimeType } }),
    ...(onProgress && {
      onProgress: ({ bytesSent, totalBytes }) => {
        // Expo can bridge native Int64 counts as BigInt.
        const total = Number(totalBytes);
        if (total > 0) onProgress(Number(bytesSent) / total);
      },
    }),
  });
}
