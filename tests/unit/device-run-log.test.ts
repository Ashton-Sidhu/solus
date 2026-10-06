import { describe, expect, test } from 'bun:test'
import { formatRunElapsed, readRunLog } from '@solus/workspace-ui/components/devices/lib/run-log'

/**
 * The build log shows steps a person reads, not the compiler commands Xcode
 * and Gradle print in full. Errors and warnings must never be hidden as noise.
 */

const xcode = [
  "CompileC /Users/me/app/ios/build/Build/Intermediates.noindex/Pods.build/Debug-iphonesimulator/ReactCodegen.build/Objects-normal/x86_64/safeareacontext-generated.o /Users/me/app/ios/build/generated/ios/ReactCodegen/safeareacontext/safeareacontext-generated.mm normal x86_64 objective-c++ com.apple.compilers.llvm.clang.1_0.compiler (in target 'ReactCodegen' from project 'Pods')",
  '    cd /Users/me/app/ios/Pods',
  '    /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang -x objective-c++ -fmodules -Wno-trigraphs -isysroot /Applications/Xcode.app/SDKs/iPhoneSimulator26.5.sdk',
  '',
  "Ld /Users/me/app/ios/build/Build/Products/Debug-iphonesimulator/App.app/App normal (in target 'App' from project 'App')",
  "/Users/me/app/ios/App/AppDelegate.swift:12:5: warning: variable 'x' was never used",
  "/Users/me/app/ios/App/AppDelegate.swift:20:1: error: cannot find 'foo' in scope",
  '** BUILD FAILED **',
].join('\n')

describe('readRunLog', () => {
  test('turns an Xcode action into a verb, the file, and its target, and drops the command under it', () => {
    const steps = readRunLog(xcode)
    expect(steps[0]).toEqual({ text: 'Compiling safeareacontext-generated.mm', target: 'ReactCodegen', tone: 'step' })
    expect(steps[1]).toEqual({ text: 'Linking App', target: 'App', tone: 'step' })
    expect(steps.some((step) => step.text.includes('clang'))).toBe(false)
  })

  test('keeps every warning and error, without the absolute path in front', () => {
    const steps = readRunLog(xcode)
    expect(steps.map((step) => step.tone)).toEqual(['step', 'step', 'warning', 'error', 'error'])
    expect(steps[2]).toEqual({ text: "variable 'x' was never used", target: 'AppDelegate.swift:12:5', tone: 'warning' })
    expect(steps[3]).toEqual({ text: "cannot find 'foo' in scope", target: 'AppDelegate.swift:20:1', tone: 'error' })
  })

  test('shows a warning the linker repeats once, named by its target', () => {
    const warning = "/Users/me/app/ios/Solus.xcodeproj: Solus: ld: warning: ignoring duplicate libraries: '-lc++'"
    const link = "Ld /Users/me/app/ios/build/Solus.debug.dylib normal (in target 'Solus' from project 'Solus')"
    const steps = readRunLog([link, warning, link, warning].join('\n'))
    expect(steps).toEqual([
      { text: 'Linking Solus.debug.dylib', target: 'Solus', tone: 'step' },
      { text: "ld: ignoring duplicate libraries: '-lc++'", target: 'Solus', tone: 'warning' },
      { text: 'Linking Solus.debug.dylib', target: 'Solus', tone: 'step' },
    ])
  })

  test('reads Gradle tasks with their project', () => {
    expect(readRunLog('> Task :app:compileDebugKotlin\n> Task :app:compileDebugKotlin\nBUILD SUCCESSFUL in 12s')).toEqual([
      { text: 'compileDebugKotlin', target: 'app', tone: 'step' },
      { text: 'BUILD SUCCESSFUL in 12s', target: null, tone: 'note' },
    ])
  })
})

test('formatRunElapsed shows minutes and seconds', () => {
  expect(formatRunElapsed(42_400)).toBe('0:42')
  expect(formatRunElapsed(725_000)).toBe('12:05')
})
