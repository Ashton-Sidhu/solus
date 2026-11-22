// Adapted from T3 Code apps/mobile/src/features/browser/PreviewStreamWebView.tsx (MIT, see UPSTREAM.md):
// its dialog card, file chooser card, and download offer.
import type {
  BrowserDownload,
  BrowserPage,
  BrowserPageDialog,
} from "@solus/contracts/browser-types";
import { browserDialogChoices } from "@solus/client-core/browser-page-requests";
import { useEffect, useRef, useState } from "react";
import { Alert, TextInput, View } from "react-native";

import { solus as app } from "../runtime";
import { AppText } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { pickComposerFiles } from "@solus-mobile/features/threads/composer-attachment-pickers";

/**
 * What the page asks of the person watching: a JavaScript dialog, files for
 * its file chooser, and the files it downloaded. A page the host renders
 * headless shows no system dialog or picker anyone could see, so the page
 * itself carries the question and the first answer from any client wins.
 */
export function BrowserPageRequests(props: {
  readonly hostId: string;
  readonly page: BrowserPage;
}) {
  useDownloadOffers(props.hostId, props.page);
  const dialog = props.page.dialog ?? null;
  const fileChooser = props.page.fileChooser ?? null;
  if (dialog)
    return (
      <PageDialogCard
        key={dialog.sequence}
        hostId={props.hostId}
        browserPageId={props.page.browserPageId}
        dialog={dialog}
      />
    );
  if (fileChooser)
    return <FileChooserCard key={fileChooser.sequence} hostId={props.hostId} page={props.page} />;
  return null;
}

function PageDialogCard(props: {
  readonly hostId: string;
  readonly browserPageId: string;
  readonly dialog: BrowserPageDialog;
}) {
  const { dialog } = props;
  const choices = browserDialogChoices(dialog);
  const [promptText, setPromptText] = useState(dialog.defaultPrompt ?? "");
  const [busy, setBusy] = useState(false);
  const answer = (accept: boolean) => {
    setBusy(true);
    const promptAnswer = dialog.type === "prompt" && accept ? { accept, promptText } : { accept };
    void app.browser
      .answerDialog(props.hostId, props.browserPageId, promptAnswer)
      .catch((cause: unknown) =>
        Alert.alert(
          "Could not answer the page",
          cause instanceof Error ? cause.message : undefined,
        ),
      )
      .finally(() => setBusy(false));
  };
  return (
    <View
      className="absolute inset-x-3 top-16 gap-3 rounded-xl border border-secondary-border bg-secondary p-4"
      accessibilityRole="alert"
    >
      <AppText className="font-t3-medium text-sm text-secondary-foreground">
        {choices.title}
      </AppText>
      {choices.message ? (
        <AppText selectable className="text-sm text-secondary-foreground">
          {choices.message}
        </AppText>
      ) : null}
      {dialog.type === "prompt" ? (
        <TextInput
          accessibilityLabel="Dialog response"
          autoFocus
          className="rounded-lg border border-input-border bg-input px-3 py-2 text-foreground"
          placeholderTextColorClassName="accent-placeholder"
          selectionColorClassName="accent-focus/32"
          value={promptText}
          onChangeText={setPromptText}
          onSubmitEditing={() => answer(true)}
        />
      ) : null}
      <View className="flex-row justify-end gap-3">
        {choices.dismiss ? (
          <ControlPill
            variant="pill"
            label={choices.dismiss}
            disabled={busy}
            onPress={() => answer(false)}
          />
        ) : null}
        <ControlPill
          variant="primary"
          label={choices.accept}
          disabled={busy}
          onPress={() => answer(true)}
        />
      </View>
    </View>
  );
}

function FileChooserCard(props: { readonly hostId: string; readonly page: BrowserPage }) {
  const multiple = props.page.fileChooser?.multiple ?? false;
  const [busy, setBusy] = useState(false);
  const answer = (pick: boolean) => {
    setBusy(true);
    void (async () => {
      const files = pick ? await pickComposerFiles(0) : null;
      // A picker the person closed gives no files; the page keeps asking.
      if (pick && files?.length === 0) return;
      await app.browser.answerFileChooser(
        props.hostId,
        props.page.browserPageId,
        files && !multiple ? files.slice(0, 1) : files,
      );
    })()
      .catch((cause: unknown) =>
        Alert.alert(
          "Could not send the files to the page",
          cause instanceof Error ? cause.message : undefined,
        ),
      )
      .finally(() => setBusy(false));
  };
  return (
    <View className="absolute inset-x-3 top-16 gap-3 rounded-xl border border-secondary-border bg-secondary p-4">
      <AppText className="text-sm text-secondary-foreground">
        The page asks for {multiple ? "files" : "a file"}.
      </AppText>
      <View className="flex-row justify-end gap-3">
        <ControlPill variant="pill" label="Cancel" disabled={busy} onPress={() => answer(false)} />
        <ControlPill
          variant="primary"
          label={busy ? "Uploading…" : `Choose ${multiple ? "files" : "file"}`}
          disabled={busy}
          onPress={() => answer(true)}
        />
      </View>
    </View>
  );
}

/** Offers each download that finishes while the viewer is open, as T3 does. */
function useDownloadOffers(hostId: string, page: BrowserPage) {
  const known = useRef<Set<string> | null>(null);
  const downloads = page.downloads;
  useEffect(() => {
    const seen = known.current;
    known.current = new Set(downloads?.map((download) => download.downloadId));
    // The downloads already on the page when the viewer opened are in its menu, not offered again.
    if (seen === null) return;
    for (const download of downloads ?? []) {
      if (!seen.has(download.downloadId))
        offerDownload(app.browser.downloadUrl.bind(app.browser), hostId, download);
    }
  }, [app, hostId, downloads]);
}

export function offerDownload(
  downloadUrl: (hostId: string, download: BrowserDownload) => Promise<string>,
  hostId: string,
  download: BrowserDownload,
) {
  Alert.alert(`Downloaded ${download.fileName}`, undefined, [
    { text: "Not now", style: "cancel" },
    { text: "Save or share", onPress: () => void saveDownload(downloadUrl, hostId, download) },
  ]);
}

export async function saveDownload(
  downloadUrl: (hostId: string, download: BrowserDownload) => Promise<string>,
  hostId: string,
  download: BrowserDownload,
) {
  try {
    await downloadAndShareAttachment({
      url: await downloadUrl(hostId, download),
      attachment: { name: download.fileName, mimeType: "application/octet-stream" },
      signal: new AbortController().signal,
    });
  } catch (cause) {
    Alert.alert("Could not save the download", cause instanceof Error ? cause.message : undefined);
  }
}
