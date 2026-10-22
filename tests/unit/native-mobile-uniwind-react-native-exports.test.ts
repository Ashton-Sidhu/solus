// Uniwind's Metro resolver replaces every `react-native` import with its own
// components module. React Native 0.88 exports `Touchable` as a property that
// is not enumerable, and Uniwind 1.13 copies React Native's exports with
// `Object.keys`, so its replacement has no `Touchable`. react-native-svg
// 15.15.5 read `Touchable.Mixin` when it loaded, and the Release app stopped
// at a white screen. react-native-svg 15.16.0 carries its own mixin. This
// checks the installed pair: if Uniwind drops `Touchable`, no react-native-svg
// source (Metro bundles `src/`) may import it.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const Touchable = { Mixin: { touchableGetInitialState: () => ({}) } };
const reactNative = {};
Object.defineProperty(reactNative, "Touchable", { configurable: true, get: () => Touchable });
// The package's exports map hides this file; Metro reaches it through Uniwind's resolver.
const uniwindModule = createRequire(import.meta.url).resolve("../../node_modules/uniwind/dist/common/components/index.js");
const requireFromUniwind = createRequire(uniwindModule);
// Uniwind requires react-native from inside node_modules, where a module mock does not reach.
requireFromUniwind.cache[requireFromUniwind.resolve("react-native")] = { exports: reactNative } as NodeJS.Module;
const uniwindReactNative = requireFromUniwind(uniwindModule) as {
  readonly Touchable?: typeof Touchable;
};

const svgSource = join(import.meta.dir, "../../node_modules/react-native-svg/src");
const importsTouchable = /import\s*\{[^}]*\bTouchable\b[^}]*\}\s*from\s*['"]react-native['"]/;

function svgFilesImportingTouchable(): string[] {
  return readdirSync(svgSource, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => importsTouchable.test(readFileSync(join(svgSource, file), "utf8")));
}

test("react-native-svg reads no Touchable that Uniwind's react-native replacement drops", () => {
  if (uniwindReactNative.Touchable?.Mixin === Touchable.Mixin) return;
  expect(svgFilesImportingTouchable()).toEqual([]);
});
