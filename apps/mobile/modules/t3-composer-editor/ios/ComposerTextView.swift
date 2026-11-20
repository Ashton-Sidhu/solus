// Adapted from T3 Code (MIT, see apps/mobile/UPSTREAM.md).
import UIKit
import UniformTypeIdentifiers

struct ComposerTokenPayload: Decodable, Equatable {
  let type: String
  let source: String
  let label: String
  let iconUri: String?
  let accent: String?
  let tintsIcon: Bool?
  let detail: String?
  var start: Int
  var end: Int

  func rendersLike(_ other: Self) -> Bool {
    var moved = other
    moved.start = start
    moved.end = end
    // String == accepts canonically equivalent sources, but their UTF-16 lengths differ.
    return moved == self && source.utf16.elementsEqual(other.source.utf16)
  }
}

struct ComposerSelectionPayload: Decodable, Equatable {
  let start: Int
  let end: Int
}

struct ComposerControlledDocumentPayload: Decodable {
  let value: String
  let selection: ComposerSelectionPayload?
  let tokensJson: String
  let mostRecentEventCount: Int
  let isNativeEcho: Bool
  let resetGeneration: Int
}

struct ComposerThemePayload: Decodable {
  let text: String
  let placeholder: String
}

enum ComposerEnterBehavior: String {
  case send
  case newline
}

final class ComposerTextAttachment: NSTextAttachment {
  let token: ComposerTokenPayload
  var source: String { token.source }
  var label: String { token.label }

  init(token: ComposerTokenPayload, image: UIImage, size: CGSize, baselineOffset: CGFloat) {
    self.token = token
    super.init(data: nil, ofType: nil)
    self.image = image
    bounds = CGRect(x: 0, y: baselineOffset, width: size.width, height: size.height)
  }

  required init?(coder: NSCoder) {
    nil
  }
}

final class ComposerContextAccessibilityElement: UIAccessibilityElement {
  var activate: (() -> Bool)?

  override func accessibilityActivate() -> Bool {
    activate?() ?? false
  }
}

final class ComposerTextView: UITextView {
  private static let pastedImageDirectoryName = "t3-composer-paste"
  private static let stalePastedImageAge: TimeInterval = 60 * 60
  private static let readOnlyActions = Set([
    "cut:",
    "delete:",
    "paste:",
    "redo:",
    "toggleBoldface:",
    "toggleItalics:",
    "toggleUnderline:",
    "undo:",
  ])

  var onPasteImages: (([String]) -> Void)?
  var onPasteContext: (([String: String]) -> Void)?
  var onPasteText: ((String, NSRange) -> Void)?
  var clipboardFragment = ""
  var onSubmit: ((Bool) -> Void)?
  var isReadOnly = false
  var textPasteThresholdBytes = 0
  var maxInputChars = Int.max
  var enterBehavior: ComposerEnterBehavior = .send
  /// JS supplies the actual send outcomes so the iPad Command-hold HUD names the configured actions.
  var submitTitle = "Send Message"
  var alternateSubmitTitle = "Send Message"
  private var bypassTextPasteInterception = false

  override var keyCommands: [UIKeyCommand]? {
    var commands = super.keyCommands ?? []
    guard !isReadOnly, markedTextRange == nil else { return commands }
    if enterBehavior == .send {
      let submitOnReturn = UIKeyCommand(
        input: "\r",
        modifierFlags: [],
        action: #selector(submitMessage(_:))
      )
      submitOnReturn.discoverabilityTitle = submitTitle
      submitOnReturn.wantsPriorityOverSystemBehavior = true
      commands.append(submitOnReturn)

      let submitAlternate = UIKeyCommand(
        input: "\r",
        modifierFlags: .command,
        action: #selector(submitMessageAlternate(_:))
      )
      submitAlternate.discoverabilityTitle = alternateSubmitTitle
      submitAlternate.wantsPriorityOverSystemBehavior = true
      commands.append(submitAlternate)

      let newline = UIKeyCommand(
        input: "\r",
        modifierFlags: .shift,
        action: #selector(insertNewline(_:))
      )
      newline.discoverabilityTitle = "New Line"
      newline.wantsPriorityOverSystemBehavior = true
      commands.append(newline)
    } else {
      let submit = UIKeyCommand(
        input: "\r",
        modifierFlags: .command,
        action: #selector(submitMessage(_:))
      )
      submit.discoverabilityTitle = submitTitle
      submit.wantsPriorityOverSystemBehavior = true
      commands.append(submit)

      let submitAlternate = UIKeyCommand(
        input: "\r",
        modifierFlags: [.command, .shift],
        action: #selector(submitMessageAlternate(_:))
      )
      submitAlternate.discoverabilityTitle = alternateSubmitTitle
      submitAlternate.wantsPriorityOverSystemBehavior = true
      commands.append(submitAlternate)
    }
    if textPasteThresholdBytes > 0 {
      let pasteAsText = UIKeyCommand(
        input: "v",
        modifierFlags: [.command, .shift],
        action: #selector(pasteInline(_:))
      )
      pasteAsText.discoverabilityTitle = "Paste as Text"
      pasteAsText.wantsPriorityOverSystemBehavior = true
      commands.append(pasteAsText)
    }
    return commands
  }

  @objc private func submitMessage(_ sender: UIKeyCommand) {
    guard !isReadOnly, markedTextRange == nil else { return }
    onSubmit?(false)
  }

  @objc private func submitMessageAlternate(_ sender: UIKeyCommand) {
    guard !isReadOnly, markedTextRange == nil else { return }
    onSubmit?(true)
  }

  @objc private func insertNewline(_ sender: UIKeyCommand) {
    guard !isReadOnly, markedTextRange == nil else { return }
    insertText("\n")
  }

  @objc private func pasteInline(_ sender: UIKeyCommand) {
    guard !isReadOnly else {
      return
    }
    bypassTextPasteInterception = true
    defer { bypassTextPasteInterception = false }
    paste(sender)
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(submitMessage(_:)) || action == #selector(insertNewline(_:)) {
      return isEditable && !isReadOnly && markedTextRange == nil
    }
    if isReadOnly && Self.readOnlyActions.contains(NSStringFromSelector(action)) {
      return false
    }
    if action == #selector(paste(_:)) {
      let pasteboard = UIPasteboard.general
      if pasteboard.hasImages ||
        pasteboard.itemProviders.contains(where: {
          $0.canLoadObject(ofClass: UIImage.self)
        }) {
        return true
      }
    }
    return super.canPerformAction(action, withSender: sender)
  }

  override func canPaste(_ itemProviders: [NSItemProvider]) -> Bool {
    guard isEditable, !isReadOnly else { return false }
    // UIKit checks canPaste before forwarding a drag to UITextDropDelegate.
    if !itemProviders.isEmpty,
       itemProviders.allSatisfy({ $0.canLoadObject(ofClass: UIImage.self) }) {
      return true
    }
    return super.canPaste(itemProviders)
  }

  override func paste(itemProviders: [NSItemProvider]) {
    guard isEditable, !isReadOnly else { return }
    if !itemProviders.isEmpty,
       itemProviders.allSatisfy({ $0.canLoadObject(ofClass: UIImage.self) }) {
      loadImages(from: itemProviders)
      return
    }
    super.paste(itemProviders: itemProviders)
  }

  override func paste(_ sender: Any?) {
    guard !isReadOnly else {
      return
    }
    let pasteboard = UIPasteboard.general
    let context = T3ComposerClipboard.read()
    if !context["fragment", default: ""].isEmpty || context["html", default: ""].contains("data-solus-attachments=") {
      onPasteContext?(context)
      return
    }
    let imageProviders = pasteboard.itemProviders.filter {
      $0.canLoadObject(ofClass: UIImage.self)
    }
    if !imageProviders.isEmpty {
      loadImages(from: imageProviders)
      return
    }

    let images = pasteboard.images ?? []
    if !images.isEmpty {
      let urls = images.compactMap(Self.writeTemporaryImage)
      if !urls.isEmpty {
        onPasteImages?(urls)
        return
      }
    }
    // pasteboard.string is only the first item; super.paste inserts every text item.
    if !bypassTextPasteInterception,
       let text = pasteboard.strings?.joined(), shouldInterceptTextPaste(text) {
      onPasteText?(text, selectedRange)
      return
    }
    // read() sees only the first item; native paste keeps every item of a longer pasteboard.
    if !bypassTextPasteInterception, pasteboard.numberOfItems == 1,
       T3ComposerClipboard.hasThreadLink(context["text", default: ""]) {
      onPasteContext?(context)
      return
    }
    super.paste(sender)
  }

  private func shouldInterceptTextPaste(_ text: String) -> Bool {
    guard textPasteThresholdBytes > 0, !text.isEmpty else { return false }
    let pastedLength = (text as NSString).length
    if pastedLength >= textPasteThresholdBytes || text.utf8.count >= textPasteThresholdBytes {
      return true
    }
    // Chips occupy one display character but expand to their source in the
    // submitted message. Measure that source, including the replaced selection.
    let sourceLength = sourceOffset(forDisplayOffset: attributedText.length)
    let selectedLength = sourceOffset(forDisplayOffset: NSMaxRange(selectedRange)) -
      sourceOffset(forDisplayOffset: selectedRange.location)
    return sourceLength - selectedLength + pastedLength > maxInputChars
  }

  override func deleteBackward() {
    guard !isReadOnly else {
      return
    }
    guard selectedRange.length == 0, selectedRange.location > 0 else {
      super.deleteBackward()
      return
    }

    let previousOffset = selectedRange.location - 1
    if textStorage.attribute(.attachment, at: previousOffset, effectiveRange: nil)
      is ComposerTextAttachment {
      replaceDisplayRange(NSRange(location: previousOffset, length: 1))
      return
    }

    super.deleteBackward()
  }

  private func replaceDisplayRange(_ range: NSRange) {
    guard let start = position(from: beginningOfDocument, offset: range.location),
          let end = position(from: start, offset: range.length),
          let textRange = textRange(from: start, to: end) else {
      return
    }
    replace(textRange, withText: "")
  }

  func loadImages(from providers: [NSItemProvider]) {
    let group = DispatchGroup()
    let lock = NSLock()
    var images = [(data: Data, fileExtension: String)?](repeating: nil, count: providers.count)

    for (index, provider) in providers.enumerated() {
      group.enter()
      let store = { (image: (data: Data, fileExtension: String)?) in
        lock.lock()
        images[index] = image
        lock.unlock()
        group.leave()
      }
      let loadPNG = {
        _ = provider.loadObject(ofClass: UIImage.self) { object, _ in
          store((object as? UIImage)?.pngData().map { ($0, "png") })
        }
      }
      // Decoding a GIF to UIImage keeps only its first frame, so pass its bytes through.
      if provider.hasItemConformingToTypeIdentifier(UTType.gif.identifier) {
        _ = provider.loadDataRepresentation(forTypeIdentifier: UTType.gif.identifier) { data, _ in
          if let data { store((data, "gif")) } else { loadPNG() }
        }
      } else {
        loadPNG()
      }
    }

    group.notify(queue: .main) { [weak self] in
      guard let self, !self.isReadOnly else {
        return
      }
      let urls = images.compactMap { $0 }.compactMap {
        Self.writeTemporaryImage($0.data, fileExtension: $0.fileExtension)
      }
      if !urls.isEmpty {
        self.onPasteImages?(urls)
      }
    }
  }

  override func copy(_ sender: Any?) {
    guard selectedRange.length > 0 else {
      return super.copy(sender)
    }
    T3ComposerClipboard.write(text: serializedText(in: selectedRange), fragment: clipboardFragment)
  }

  override func cut(_ sender: Any?) {
    guard !isReadOnly else {
      return
    }
    guard isEditable, selectedRange.length > 0 else {
      return super.cut(sender)
    }
    copy(sender)
    replaceDisplayRange(selectedRange)
  }

  func serializedText() -> String {
    serializedText(in: NSRange(location: 0, length: attributedText.length))
  }

  func serializedText(in range: NSRange) -> String {
    guard range.length > 0 else {
      return ""
    }

    let source = NSMutableString()
    let nsString = attributedText.string as NSString
    var cursor = range.location
    let end = NSMaxRange(range)
    attributedText.enumerateAttribute(.attachment, in: range) { value, attachmentRange, _ in
      if attachmentRange.location > cursor {
        source.append(
          nsString.substring(
            with: NSRange(location: cursor, length: attachmentRange.location - cursor)
          )
        )
      }
      if let attachment = value as? ComposerTextAttachment {
        source.append(attachment.source)
      } else {
        source.append(nsString.substring(with: attachmentRange))
      }
      cursor = NSMaxRange(attachmentRange)
    }
    if cursor < end {
      source.append(nsString.substring(with: NSRange(location: cursor, length: end - cursor)))
    }
    return source as String
  }

  func sourceOffset(forDisplayOffset displayOffset: Int) -> Int {
    let boundedOffset = max(0, min(attributedText.length, displayOffset))
    if boundedOffset == 0 {
      return 0
    }

    var sourceOffset = 0
    let range = NSRange(location: 0, length: boundedOffset)
    attributedText.enumerateAttribute(.attachment, in: range) { value, attributeRange, _ in
      if let attachment = value as? ComposerTextAttachment {
        sourceOffset += (attachment.source as NSString).length
      } else {
        sourceOffset += attributeRange.length
      }
    }
    return sourceOffset
  }

  private static func writeTemporaryImage(_ image: UIImage) -> String? {
    image.pngData().flatMap { writeTemporaryImage($0, fileExtension: "png") }
  }

  private static func writeTemporaryImage(_ data: Data, fileExtension: String) -> String? {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(pastedImageDirectoryName, isDirectory: true)
    do {
      try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: true
      )
      removeStaleTemporaryImages(in: directory)
      let url = directory.appendingPathComponent("\(UUID().uuidString).\(fileExtension)")
      try data.write(to: url, options: .atomic)
      return url.absoluteString
    } catch {
      return nil
    }
  }

  private static func removeStaleTemporaryImages(in directory: URL) {
    let cutoff = Date().addingTimeInterval(-stalePastedImageAge)
    guard let urls = try? FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
      options: [.skipsHiddenFiles]
    ) else {
      return
    }

    for url in urls {
      guard
        let values = try? url.resourceValues(
          forKeys: [.contentModificationDateKey, .isRegularFileKey]
        ),
        values.isRegularFile == true,
        let modifiedAt = values.contentModificationDate,
        modifiedAt < cutoff
      else {
        continue
      }
      try? FileManager.default.removeItem(at: url)
    }
  }
}

