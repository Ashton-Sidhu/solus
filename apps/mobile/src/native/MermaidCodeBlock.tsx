// Adapted from T3 Code apps/mobile/src/native/MermaidCodeBlock.tsx (MIT, see UPSTREAM.md).
// The full-screen image is named by a SHA-256 of its SVG (expo-crypto, not Effect's
// Hash), and the block takes the Solus native code block's border and radius.
import * as Crypto from "expo-crypto";
import { File, Paths } from "expo-file-system";
import * as Haptics from "expo-haptics";
import type { DiagramType } from "pele/lazy";
import { Suspense, use, useRef, useState } from "react";
import { PixelRatio, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { parse, Svg, SvgXml } from "react-native-svg";

import { SymbolView, type AppSymbolName } from "../components/AppSymbol";
import { MediaImagePreview } from "../components/MediaImagePreview";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { mermaidSvgForNative, withDiagramBackground } from "../lib/mermaidSvg";
import { themeColorWithAlpha } from "../lib/mobileTheme";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

type Pele = typeof import("pele/lazy");
type Diagram =
  | {
      readonly status: "ready";
      readonly svg: string;
      readonly width: number;
      readonly height: number;
    }
  | { readonly status: "error"; readonly message: string };

let peleLoad: Promise<Pele | null> | null = null;
// Each diagram type is its own chunk, so a thread with one flowchart only
// evaluates the flowchart parser and layout.
const typeLoads = new Map<DiagramType, Promise<boolean>>();
// A message scrolled back into view reuses its settled promise, which `use`
// reads without suspending, instead of flashing the source.
const diagramLoads = new Map<string, Promise<Diagram>>();
const DIAGRAM_CACHE_LIMIT = 64;

function loadDiagram(source: string): Promise<Diagram> {
  let load = diagramLoads.get(source);
  if (!load) {
    if (diagramLoads.size >= DIAGRAM_CACHE_LIMIT) {
      diagramLoads.delete(diagramLoads.keys().next().value!);
    }
    load = renderDiagram(source);
    diagramLoads.set(source, load);
  }
  return load;
}

const MONOSPACE = Platform.OS === "ios" ? "Menlo" : "monospace";
// Pele measures labels with metrics close to Helvetica when no canvas is available.
const DIAGRAM_FONT = Platform.OS === "ios" ? "Helvetica" : "sans-serif";

async function renderDiagram(source: string): Promise<Diagram> {
  peleLoad ??= import("pele/lazy").catch(() => null);
  const pele = await peleLoad;
  if (!pele) {
    // Not cached, so the next mount tries again.
    peleLoad = null;
    diagramLoads.delete(source);
    return { status: "error", message: "The diagram renderer failed to load." };
  }
  let type: DiagramType | null = null;
  try {
    type = pele.detectType(source);
  } catch {
    // An unknown type falls through to render, which reports why.
  }
  if (type) {
    let load = typeLoads.get(type);
    if (!load) {
      load = pele.load(type).then(
        () => true,
        () => false,
      );
      typeLoads.set(type, load);
    }
    if (!(await load)) {
      typeLoads.delete(type);
      diagramLoads.delete(source);
      return { status: "error", message: "The diagram renderer failed to load." };
    }
  }
  try {
    const { svg, width, height } = pele.render(source, {
      links: false,
      images: false,
      // Keep the author's direction; a wide diagram scales down to fit instead of turning vertical.
      autoDirection: false,
    });
    return { status: "ready", svg, width, height };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "The diagram could not be rendered.",
    };
  }
}

// The image viewer zooms a bitmap: about twice a phone's screen leaves room to zoom while
// bounding the memory one image takes.
const EXPORT_LONGEST_SIDE = 3072;

/** Named by content, so a theme change never shows a stale image cached under the same URI. */
async function writeDiagramImage(xml: string, base64: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, xml);
  const file = new File(Paths.cache, "solus-diagrams", `${digest.slice(0, 16)}.png`);
  file.create({ intermediates: true, overwrite: true });
  await file.write(base64, { encoding: "base64" });
  return file.uri;
}

type ReadyDiagram = Extract<Diagram, { readonly status: "ready" }>;

type MermaidCodeBlockProps = {
  readonly code: string;
  readonly textStyle: NativeMarkdownTextStyle;
};

/** A closed ```mermaid fence, drawn as its diagram with a toggle back to the source. */
export function MermaidCodeBlock(props: MermaidCodeBlockProps) {
  return (
    <Suspense fallback={<MermaidBlock {...props} diagram={null} />}>
      <RenderedMermaidBlock {...props} />
    </Suspense>
  );
}

function RenderedMermaidBlock(props: MermaidCodeBlockProps) {
  return <MermaidBlock {...props} diagram={use(loadDiagram(props.code.trim()))} />;
}

/** Pele's SVG in the message's colors, with every value react-native-svg cannot resolve made literal. */
function themedDiagramSvg(svg: string, textStyle: NativeMarkdownTextStyle): string {
  return mermaidSvgForNative(svg, {
    "--pele-bg": textStyle.codeBlockBackgroundColor,
    "--pele-fg": textStyle.color,
    "--pele-muted": themeColorWithAlpha(textStyle.color, 0.65),
    "--pele-line": themeColorWithAlpha(textStyle.color, 0.55),
    "--pele-surface": themeColorWithAlpha(textStyle.color, 0.06),
    "--pele-surface-alt": themeColorWithAlpha(textStyle.color, 0.12),
    "--pele-border": themeColorWithAlpha(textStyle.color, 0.28),
    "--pele-accent": textStyle.linkColor,
    "--pele-font": DIAGRAM_FONT,
    "--pele-font-mono": MONOSPACE,
  });
}

function MermaidBlock(props: MermaidCodeBlockProps & { readonly diagram: Diagram | null }) {
  const { code, textStyle, diagram } = props;
  const [showCode, setShowCode] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const secondaryColor = themeColorWithAlpha(textStyle.codeColor, 0.6);
  // The native code block's size (`EnrichedMarkdownText.tsx`).
  const codeFontSize = textStyle.fontSize * (0.8125 / 0.875);
  const ready = diagram?.status === "ready" ? diagram : null;
  const svg = ready ? themedDiagramSvg(ready.svg, textStyle) : null;

  return (
    <View
      style={[
        styles.block,
        {
          backgroundColor: textStyle.codeBlockBackgroundColor,
          borderColor: textStyle.blockBorderColor,
        },
      ]}
    >
      <MermaidHeader
        code={code}
        textStyle={textStyle}
        fontSize={codeFontSize * 0.85}
        showCode={showCode}
        onToggleCode={svg ? () => setShowCode((value) => !value) : null}
      />
      <View style={styles.content}>
        {diagram?.status === "error" ? (
          <Text style={[styles.error, { color: secondaryColor, fontSize: codeFontSize * 0.85 }]}>
            Unable to render diagram: {diagram.message}
          </Text>
        ) : null}
        {svg && ready && !showCode ? (
          // In a row the width resolves first, so the height follows the shrunk width;
          // a column with maxWidth would size the height from the full width.
          <View style={styles.diagramRow}>
            <Pressable
              accessibilityRole="imagebutton"
              accessibilityLabel="Mermaid diagram"
              accessibilityHint="Opens the diagram full screen"
              onPress={() => {
                if (isExpanded) return;
                void Haptics.selectionAsync();
                setIsExpanded(true);
              }}
              style={{
                flexBasis: ready.width,
                flexShrink: 1,
                aspectRatio: ready.width / ready.height,
              }}
            >
              <SvgXml xml={svg} width="100%" height="100%" />
            </Pressable>
          </View>
        ) : (
          <Text
            selectable
            style={{
              color: textStyle.codeColor,
              fontFamily: MONOSPACE,
              fontSize: codeFontSize,
              lineHeight: codeFontSize * 1.55,
            }}
          >
            {code}
          </Text>
        )}
      </View>
      {isExpanded && svg && ready ? (
        <DiagramFullScreen
          svg={svg}
          diagram={ready}
          background={textStyle.codeBlockBackgroundColor}
          onClose={() => setIsExpanded(false)}
        />
      ) : null}
    </View>
  );
}

/** The header copies the native code block's, which this block replaces once the fence closes. */
function MermaidHeader(props: {
  readonly code: string;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly fontSize: number;
  readonly showCode: boolean;
  /** Null until the diagram draws: there is nothing to toggle to. */
  readonly onToggleCode: (() => void) | null;
}) {
  const { code, textStyle, showCode, onToggleCode } = props;
  const secondaryColor = themeColorWithAlpha(textStyle.codeColor, 0.6);
  return (
    <View
      style={[styles.header, { borderBottomColor: themeColorWithAlpha(textStyle.codeColor, 0.2) }]}
    >
      <Text style={[styles.language, { color: secondaryColor, fontSize: props.fontSize }]}>
        Mermaid
      </Text>
      <View style={styles.actions}>
        {onToggleCode ? (
          <HeaderButton
            icon={showCode ? "flowchart" : "chevron.left.forwardslash.chevron.right"}
            label={showCode ? "Show diagram" : "Show code"}
            color={secondaryColor}
            onPress={onToggleCode}
          />
        ) : null}
        <HeaderButton
          icon="doc.on.doc"
          label="Copy code"
          color={secondaryColor}
          onPress={() => copyTextWithHaptic(code)}
        />
      </View>
    </View>
  );
}

/**
 * The image viewer draws bitmaps, so the diagram is first drawn again off screen
 * at the export size and saved as a PNG, then opened in the viewer Markdown
 * images use (zoom, save, share).
 */
function DiagramFullScreen(props: {
  readonly svg: string;
  readonly diagram: ReadyDiagram;
  readonly background: string;
  readonly onClose: () => void;
}) {
  const { diagram, onClose } = props;
  const [uri, setUri] = useState<string | null>(null);
  const exportSvg = useRef<Svg>(null);
  const exportXml = withDiagramBackground(props.svg, props.background);
  const exportTree = parse(exportXml);
  const exportScale = EXPORT_LONGEST_SIDE / Math.max(diagram.width, diagram.height);
  // In points. iOS draws the copy at its own size and the screen scale, Android at the
  // requested pixels, so the copy is laid out at the export size for both.
  const exportSize = {
    width: (diagram.width * exportScale) / PixelRatio.get(),
    height: (diagram.height * exportScale) / PixelRatio.get(),
  };

  // Runs once the hidden export copy has laid out.
  const exportDiagram = () => {
    if (!exportSvg.current) return;
    const pixels = Platform.OS === "ios" ? 1 : PixelRatio.get();
    exportSvg.current.toDataURL(
      (base64) => {
        // A failed capture calls back with nothing; let the next tap try again.
        if (!base64) {
          onClose();
          return;
        }
        // iOS wraps the encoding in line feeds.
        writeDiagramImage(exportXml, base64.replace(/\s/g, "")).then(setUri, onClose);
      },
      {
        width: Math.round(exportSize.width * pixels),
        height: Math.round(exportSize.height * pixels),
      },
    );
  };

  if (uri) {
    return (
      <MediaImagePreview
        source={{
          kind: "image",
          uri,
          name: "Mermaid diagram",
          mimeType: "image/png",
          actionsSource: {
            name: "Mermaid diagram.png",
            mimeType: "image/png",
            resolveUri: async () => uri,
          },
        }}
        onRequestClose={onClose}
      />
    );
  }
  if (!exportTree) return null;
  return (
    <View pointerEvents="none" style={[styles.exportCopy, exportSize]} onLayout={exportDiagram}>
      <Svg ref={exportSvg} {...exportTree.props} width="100%" height="100%">
        {exportTree.children}
      </Svg>
    </View>
  );
}

function HeaderButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly color: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={10}
      onPress={props.onPress}
    >
      <SymbolView name={props.icon} size={14} tintColor={props.color} type="monochrome" />
    </Pressable>
  );
}

// The block slot already applies the code block's outer margins. The border and
// radius are the native code block's (`EnrichedMarkdownText.tsx`).
const styles = StyleSheet.create({
  block: {
    borderRadius: 10,
    borderWidth: 1,
    overflow: "hidden",
  },
  header: {
    height: 32,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  language: { fontWeight: "500" },
  actions: { flexDirection: "row", alignItems: "center", gap: 14 },
  content: { padding: 12 },
  diagramRow: { flexDirection: "row", justifyContent: "center" },
  error: { marginBottom: 8 },
  exportCopy: { position: "absolute", opacity: 0 },
});
