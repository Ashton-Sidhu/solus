import { useCheckoutAccess } from "../../solus/use-checkout-files";
import type { EnvironmentId } from "@t3tools/contracts";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { SheetPane } from "../../components/ui/SheetPane";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { FileTreeBrowser } from "./FileTreeBrowser";
import { useFileTreeEntries } from "./useFileTreeEntries";
import { preloadWorkspaceFileContents } from "./preload-workspace-file";

export function ThreadFileNavigatorPane(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly projectName: string;
  readonly selectedPath: string | null;
  readonly onSelectFile: (path: string) => void;
}) {
  const gt = useGT();
  const workspaceKey = JSON.stringify([props.environmentId, props.cwd]);
  // The pane stays mounted across thread switches; a query only filters the workspace it was typed in.
  const [search, setSearch] = useState({ workspaceKey, query: "" });
  const searchQuery = search.workspaceKey === workspaceKey ? search.query : "";
  const setSearchQuery = (query: string) => setSearch({ workspaceKey, query });
  const { themeAppearance: highlightTheme } = useAppearancePreferences();
  const fileAccess = useCheckoutAccess(props.environmentId);
  const { canReadFiles } = fileAccess;
  const entriesQuery = useFileTreeEntries({
    environmentId: props.environmentId,
    cwd: canReadFiles ? props.cwd : null,
    searchQuery,
  });
  const handlePreviewFile = (relativePath: string) => {
    preloadWorkspaceFileContents({
      cwd: props.cwd,
      environmentId: props.environmentId,
      relativePath,
      theme: highlightTheme,
    });
  };
  const fileTree = (
    <FileTreeBrowser
      key={workspaceKey}
      cwd={props.cwd}
      revealSelection={entriesQuery.revealSelection}
      expandedPaths={entriesQuery.expandedPaths}
      setExpandedPaths={entriesQuery.setExpandedPaths}
      entries={entriesQuery.entries}
      loadingDirectories={entriesQuery.loadingDirectories}
      onLoadDirectory={entriesQuery.loadDirectory}
      error={
        canReadFiles
          ? entriesQuery.error
          : fileAccess.isPending
            ? null
            : (fileAccess.error ?? gt("This connection cannot read host files."))
      }
      isPending={fileAccess.isPending || entriesQuery.isPending}
      isRefreshing={entriesQuery.isRefreshing}
      searchQuery={searchQuery}
      searchResultPaths={entriesQuery.searchResultPaths}
      searchTruncated={entriesQuery.searchTruncated}
      selectedPath={props.selectedPath ?? entriesQuery.selectedPath}
      onPreviewFile={handlePreviewFile}
      onRefresh={entriesQuery.refresh}
      onSelectFile={(path) => {
        entriesQuery.selectPath(path);
        props.onSelectFile(path);
      }}
    />
  );

  return (
    <SheetPane>
      <AppBar
        title={gt("Files", { $context: "screen title, workspace files" })}
        subtitle={props.projectName}
        search={{
          value: searchQuery,
          onChangeText: setSearchQuery,
          placeholder: gt("Search files"),
        }}
        refresh={{ accessibilityLabel: gt("Refresh files"), onPress: entriesQuery.refresh }}
      />
      <ScreenContent insetHorizontal>{fileTree}</ScreenContent>
    </SheetPane>
  );
}
