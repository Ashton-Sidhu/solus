// Android side of the iOS key commands in `SolusKeyboardCommandsModule.swift`.
// Only hardware Return is handled here; the other commands are iOS only.
package expo.modules.soluskeyboardcommands

import android.content.Context
import android.view.KeyEvent
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class SolusKeyboardCommandsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SolusKeyboardCommands")

    View(SolusKeyboardCommandsView::class) {
      Prop("enabledCommands") { view: SolusKeyboardCommandsView, commands: List<String> ->
        view.enabledCommands = commands.toSet()
      }
      Events("onCommand")
    }
  }
}

/** Wraps the app. A key goes down the view tree to the focused view, so this
 *  view sees Return before the composer's text input types a line break. */
class SolusKeyboardCommandsView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onCommand by EventDispatcher()
  internal var enabledCommands = emptySet<String>()

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val device = event.device
    val action = returnKeyAction(
      keyCode = event.keyCode,
      action = event.action,
      repeatCount = event.repeatCount,
      metaState = event.metaState,
      flags = event.flags,
      isVirtualDevice = device?.isVirtual,
      keyboardType = device?.keyboardType ?: 0,
      enabledCommands = enabledCommands,
    )
    return when (action) {
      ReturnKeyAction.PassThrough -> super.dispatchKeyEvent(event)
      ReturnKeyAction.Swallow -> true
      is ReturnKeyAction.Emit -> {
        onCommand(mapOf("command" to action.command))
        true
      }
    }
  }
}
