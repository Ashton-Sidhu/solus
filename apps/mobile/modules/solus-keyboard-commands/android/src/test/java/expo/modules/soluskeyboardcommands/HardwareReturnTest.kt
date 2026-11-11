package expo.modules.soluskeyboardcommands

import android.view.InputDevice
import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class HardwareReturnTest {
  private val composerFocused = setOf("send", "sendOnReturn")

  @Suppress("LongParameterList")
  private fun press(
    metaState: Int = 0,
    flags: Int = 0,
    isVirtualDevice: Boolean? = false,
    keyboardType: Int = InputDevice.KEYBOARD_TYPE_ALPHABETIC,
    action: Int = KeyEvent.ACTION_DOWN,
    repeatCount: Int = 0,
    keyCode: Int = KeyEvent.KEYCODE_ENTER,
    enabledCommands: Set<String> = composerFocused,
  ) = returnKeyAction(keyCode, action, repeatCount, metaState, flags, isVirtualDevice, keyboardType, enabledCommands)

  private fun emitted(action: ReturnKeyAction): String? = (action as? ReturnKeyAction.Emit)?.command

  @Test
  fun returnSendsAndCtrlReturnSendsFromAnywhere() {
    assertEquals("sendOnReturn", emitted(press()))
    assertEquals("sendOnReturn", emitted(press(keyCode = KeyEvent.KEYCODE_NUMPAD_ENTER)))
    assertEquals("send", emitted(press(metaState = KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON)))
    assertEquals("send", emitted(press(metaState = KeyEvent.META_CTRL_ON, enabledCommands = setOf("send"))))
  }

  @Test
  fun shiftReturnAndOtherChordsBreakTheLine() {
    assertSame(ReturnKeyAction.PassThrough, press(metaState = KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON))
    assertSame(ReturnKeyAction.PassThrough, press(metaState = KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON))
    assertSame(ReturnKeyAction.PassThrough, press(metaState = KeyEvent.META_ALT_ON))
  }

  @Test
  fun lockKeysDoNotCountAsModifiers() {
    assertEquals("sendOnReturn", emitted(press(metaState = KeyEvent.META_CAPS_LOCK_ON or KeyEvent.META_NUM_LOCK_ON)))
  }

  @Test
  fun onScreenKeyboardReturnBreaksTheLine() {
    assertSame(ReturnKeyAction.PassThrough, press(flags = KeyEvent.FLAG_SOFT_KEYBOARD))
    assertSame(ReturnKeyAction.PassThrough, press(isVirtualDevice = true))
    // Some input methods send device 0, the phone's key-only built-in keyboard, without FLAG_SOFT_KEYBOARD.
    assertSame(ReturnKeyAction.PassThrough, press(keyboardType = InputDevice.KEYBOARD_TYPE_NON_ALPHABETIC))
    assertSame(ReturnKeyAction.PassThrough, press(isVirtualDevice = null))
  }

  @Test
  fun heldReturnSendsOnce() {
    assertEquals("sendOnReturn", emitted(press()))
    assertSame(ReturnKeyAction.Swallow, press(repeatCount = 1))
    assertSame(ReturnKeyAction.Swallow, press(repeatCount = 2))
    assertSame(ReturnKeyAction.Swallow, press(action = KeyEvent.ACTION_UP))
  }

  @Test
  fun returnBreaksTheLineWhenNoComposerHasFocus() {
    assertSame(ReturnKeyAction.PassThrough, press(enabledCommands = setOf("send")))
    assertSame(ReturnKeyAction.PassThrough, press(metaState = KeyEvent.META_CTRL_ON, enabledCommands = emptySet()))
  }
}
