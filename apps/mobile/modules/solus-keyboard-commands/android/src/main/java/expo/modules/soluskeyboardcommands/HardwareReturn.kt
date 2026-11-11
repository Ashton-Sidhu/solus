// The Return filter is adapted from T3 Code `T3ComposerEditorView.kt`
// `returnSubmission` and `isFromPhysicalKeyboard` (MIT, pingdotgg/t3code#21687;
// see apps/mobile/UPSTREAM.md).
package expo.modules.soluskeyboardcommands

import android.view.InputDevice
import android.view.KeyEvent

/** What the wrapper does with one key event. */
internal sealed interface ReturnKeyAction {
  /** Not a command Return: the focused view gets the key. */
  object PassThrough : ReturnKeyAction

  /** A command Return that already fired (a key repeat or the key up). */
  object Swallow : ReturnKeyAction

  class Emit(val command: String) : ReturnKeyAction
}

private const val OTHER_MODIFIERS =
  KeyEvent.META_SHIFT_MASK or KeyEvent.META_ALT_MASK or KeyEvent.META_META_MASK or
    KeyEvent.META_SYM_ON or KeyEvent.META_FUNCTION_ON

/**
 * Return from a hardware keyboard: `sendOnReturn` with no modifier, `send`
 * with Ctrl (Android's Command). Shift-Return and every other chord stay with
 * the text input as a line break. A command fires once, on the first key down.
 *
 * Input methods can send Return from device 0 without FLAG_SOFT_KEYBOARD, so
 * only a real alphabetic keyboard counts. `isVirtualDevice` is null when the
 * event has no device.
 */
@Suppress("LongParameterList") // Plain values keep the filter testable without Android.
internal fun returnKeyAction(
  keyCode: Int,
  action: Int,
  repeatCount: Int,
  metaState: Int,
  flags: Int,
  isVirtualDevice: Boolean?,
  keyboardType: Int,
  enabledCommands: Set<String>,
): ReturnKeyAction {
  val isReturn = keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER
  val isHardware = (flags and KeyEvent.FLAG_SOFT_KEYBOARD) == 0 &&
    isVirtualDevice == false &&
    keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC
  if (!isReturn || !isHardware || (metaState and OTHER_MODIFIERS) != 0) return ReturnKeyAction.PassThrough
  val command = if ((metaState and KeyEvent.META_CTRL_MASK) != 0) "send" else "sendOnReturn"
  if (command !in enabledCommands) return ReturnKeyAction.PassThrough
  return if (action == KeyEvent.ACTION_DOWN && repeatCount == 0) {
    ReturnKeyAction.Emit(command)
  } else {
    ReturnKeyAction.Swallow
  }
}
