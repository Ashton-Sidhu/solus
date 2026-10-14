// Adapted from T3 Code `modules/t3-native-controls/ios/T3KeyboardCommandsModule.swift`
// (MIT, commit 43bd667739; see apps/mobile/UPSTREAM.md). Only the mechanism is
// kept: a view in the responder chain that offers key commands. The commands
// are Solus's own.
import ExpoModulesCore
import UIKit

public final class SolusKeyboardCommandsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SolusKeyboardCommands")

    View(SolusKeyboardCommandsView.self) {
      Prop("enabledCommands") { (view: SolusKeyboardCommandsView, commands: [String]) in
        view.setEnabledCommands(commands)
      }
      Events("onCommand")
    }
  }
}

/// Wraps the app. UIKit gathers key commands from every responder in the
/// chain, so these work while the composer's text view is first responder.
/// With no text input focused, the view takes first responder itself.
public final class SolusKeyboardCommandsView: ExpoView {
  let onCommand = EventDispatcher()
  private var enabledCommands = Set<String>()

  public override var canBecomeFirstResponder: Bool { true }

  public override var keyCommands: [UIKeyCommand]? {
    [
      enabledCommand("send", input: "\r", modifiers: .command, action: #selector(send), title: "Send"),
      enabledCommand("sendOnReturn", input: "\r", modifiers: [], action: #selector(sendOnReturn), title: "Send"),
      enabledCommand("newSession", input: "n", modifiers: .command, action: #selector(newSession), title: "New Session"),
      enabledCommand("toggleSidebar", input: "b", modifiers: .command, action: #selector(toggleSessionSidebar), title: "Toggle Sidebar"),
      enabledCommand("focusInput", input: "l", modifiers: .command, action: #selector(focusInput), title: "Focus Input"),
      enabledCommand("stop", input: "c", modifiers: .control, action: #selector(stop), title: "Stop Agent"),
      enabledCommand("back", input: "[", modifiers: .command, action: #selector(goBack), title: "Back"),
    ].compactMap { $0 }
  }

  func setEnabledCommands(_ commands: [String]) {
    enabledCommands = Set(commands)
    reclaimFirstResponderIfAvailable()
  }

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    for name in [UITextView.textDidEndEditingNotification, UITextField.textDidEndEditingNotification, UIApplication.didBecomeActiveNotification] {
      NotificationCenter.default.addObserver(self, selector: #selector(reclaimFirstResponderIfAvailable), name: name, object: nil)
    }
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    reclaimFirstResponderIfAvailable()
  }

  private func enabledCommand(_ identifier: String, input: String, modifiers: UIKeyModifierFlags, action: Selector, title: String) -> UIKeyCommand? {
    guard enabledCommands.contains(identifier) else { return nil }
    let command = UIKeyCommand(input: input, modifierFlags: modifiers, action: action)
    command.discoverabilityTitle = title
    command.wantsPriorityOverSystemBehavior = true
    return command
  }

  @objc private func send() { emit("send") }
  @objc private func sendOnReturn() { emit("sendOnReturn") }
  @objc private func newSession() { emit("newSession") }
  @objc private func toggleSessionSidebar() { emit("toggleSidebar") }
  @objc private func focusInput() { emit("focusInput") }
  @objc private func stop() { emit("stop") }
  @objc private func goBack() { emit("back") }

  /// Return confirms an input method's marked text (for example, Japanese)
  /// before it can send.
  public override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(sendOnReturn),
       let input = window?.solusFirstResponder as? UITextInput,
       input.markedTextRange != nil {
      return false
    }
    return super.canPerformAction(action, withSender: sender)
  }

  private func emit(_ command: String) {
    onCommand(["command": command])
  }

  @objc private func reclaimFirstResponderIfAvailable() {
    DispatchQueue.main.async { [weak self] in
      guard let self, self.window?.solusFirstResponder == nil else { return }
      self.becomeFirstResponder()
    }
  }
}

private extension UIView {
  var solusFirstResponder: UIResponder? {
    if isFirstResponder { return self }
    for subview in subviews {
      if let responder = subview.solusFirstResponder { return responder }
    }
    return nil
  }
}
