import { useCallback, useState } from "react";
import { Alert, View } from "react-native";

import { appFileRefusal, readAppFileParts, uploadAppFile } from "@solus/client-core/app-files";
import type { HostApi } from "@solus/client-core/host-api";
import type { AppFileView } from "@solus/contracts/apps";

import { SettingsActionRow } from "../../settings/components/SettingsActionRow";
import { SettingsNote } from "../../settings/components/SettingsNote";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { errorMessage } from "../../settings/integrations";
import { PillButton } from "../../webhooks/webhook-rows";
import { pickDeviceFile, pickedFileSource, shareFileParts } from "../app-device-files";
import { fileLines, sortFiles, uploadProgressText, type FileUpload } from "../app-file-source";
import { AppDetailRow, LoadedSection } from "../app-rows";
import { bytesText } from "../apps";
import { useAppChange, useAppHostCall, useAppRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

/**
 * Files (docs/plans/apps.md §4.3, §9.2): the app files. The owner uploads a
 * file from the phone's file chooser, takes one out through the share sheet,
 * and deletes one. A file crosses in parts through the app's own call, so an
 * upload shows how far it is.
 */
export function FilesSection({ hostId, appId, connected }: AppSectionProps) {
  const readFiles = useCallback((api: HostApi) => api.appFiles({ appId }), [appId]);
  const files = useAppRead(hostId, appId, "files", readFiles);
  const callHost = useAppHostCall(hostId, appId);
  const { busy, change } = useAppChange(hostId);
  const [upload, setUpload] = useState<FileUpload | null>(null);
  /** The file whose bytes are read for the share sheet. */
  const [sharingId, setSharingId] = useState<string | null>(null);
  const disabled = busy !== null || !connected;
  const reloadFiles = files.reload;
  const now = Date.now();

  const uploadFile = async () => {
    const picked = await pickDeviceFile();
    if (!picked) return;
    const refusal = appFileRefusal(picked.size);
    if (refusal) throw new Error(refusal);
    setUpload({ name: picked.name, sentBytes: 0, size: picked.size });
    await uploadAppFile(callHost, pickedFileSource(picked), (sentBytes) => setUpload({ name: picked.name, sentBytes, size: picked.size }));
  };

  const startUpload = () => {
    void uploadFile()
      .then(reloadFiles, (cause: unknown) => Alert.alert("Not uploaded", errorMessage(cause)))
      .finally(() => setUpload(null));
  };

  const share = (file: AppFileView) => {
    setSharingId(file.id);
    void readAppFileParts(callHost, file.id)
      .then((parts) => shareFileParts(file, parts))
      .catch((cause: unknown) => Alert.alert("Not opened", errorMessage(cause)))
      .finally(() => setSharingId(null));
  };

  const remove = (file: AppFileView) => {
    Alert.alert(`Delete ${file.name}?`, "The app loses this file. You cannot undo this.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          change("file", (api) => api.appFileRemove({ appId, fileId: file.id })).then(reloadFiles, (cause: unknown) =>
            Alert.alert("Not deleted", errorMessage(cause)),
          );
        },
      },
    ]);
  };

  return (
    <>
      <View className="gap-3">
        <SettingsSection title="Upload">
          <SettingsActionRow
            icon="tray.and.arrow.up"
            label="Upload a file"
            disabled={!connected || upload !== null}
            loading={upload !== null}
            onPress={startUpload}
          />
        </SettingsSection>
        <SettingsNote>{upload ? uploadProgressText(upload) : "One file is at most 64 MiB. The app reads it as an app file."}</SettingsNote>
      </View>
      <LoadedSection
        title="Files"
        read={files.state}
        connected={connected}
        subject="The app files"
        empty="This app holds no file."
        onRetry={files.reload}
      >
        {(items) =>
          sortFiles(items).map((file, index) => (
            <AppDetailRow key={file.id} first={index === 0} title={file.name} trailing={bytesText(file.size)} lines={fileLines(file, now)}>
              <PillButton
                label={sharingId === file.id ? "Reading the file" : "Save or share"}
                disabled={!connected || sharingId !== null}
                onPress={() => share(file)}
              />
              <PillButton label="Delete" disabled={disabled} onPress={() => remove(file)} />
            </AppDetailRow>
          ))
        }
      </LoadedSection>
    </>
  );
}
