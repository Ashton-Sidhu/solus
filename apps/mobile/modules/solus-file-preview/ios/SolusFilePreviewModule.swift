// Adapted from T3 Code apps/mobile/modules/t3-native-controls/ios/T3NativeControlsModule.swift (MIT, see apps/mobile/UPSTREAM.md).
// The Quick Look file presentation (`presentFiles`, `dismissFile`) and the
// AVPlayerViewController video presentation (`presentVideo`, `dismissVideo`):
// no presentation sources or share sheet.
import ExpoModulesCore
import UIKit

public final class SolusFilePreviewModule: Module {
  private var filePresentation: SolusFilePresentation?
  private var videoPresentation: SolusVideoPresentation?

  public func definition() -> ModuleDefinition {
    Name("SolusFilePreview")

    AsyncFunction("presentFiles") { (urls: [URL], titles: [String], selectedIndex: Int, identifier: String, promise: Promise) in
      guard !urls.isEmpty, urls.count == titles.count, urls.indices.contains(selectedIndex) else {
        throw URLError(.badURL)
      }
      guard self.filePresentation == nil, self.videoPresentation == nil,
        let presenter = self.appContext?.utilities?.currentViewController()
      else { throw URLError(.cannotLoadFromNetwork) }
      let file = SolusFilePresentation(identifier: identifier) { [weak self] error in
        self?.filePresentation = nil
        if let error { promise.reject(error) } else { promise.resolve(nil) }
      }
      self.filePresentation = file
      file.present(urls: urls, titles: titles, selectedIndex: selectedIndex, from: presenter)
    }.runOnQueue(.main)

    AsyncFunction("dismissFile") { (identifier: String) in
      if self.filePresentation?.identifier == identifier { self.filePresentation?.dismiss() }
    }.runOnQueue(.main)

    AsyncFunction("presentVideo") { (url: URL, title: String, identifier: String, promise: Promise) in
      let isPlayableURL = ["https", "http"].contains(url.scheme?.lowercased() ?? "") && url.host != nil
      guard self.videoPresentation == nil, self.filePresentation == nil,
        let presenter = self.appContext?.utilities?.currentViewController(),
        isPlayableURL
      else {
        throw NSError(
          domain: "SolusVideo",
          code: 2,
          userInfo: [NSLocalizedDescriptionKey: "The video preview is no longer available."]
        )
      }
      let video = SolusVideoPresentation(identifier: identifier, url: url, title: title) { [weak self] error in
        self?.videoPresentation = nil
        if let error { promise.reject(error) } else { promise.resolve(nil) }
      }
      self.videoPresentation = video
      video.present(from: presenter)
    }.runOnQueue(.main)

    AsyncFunction("dismissVideo") { (identifier: String) in
      if self.videoPresentation?.identifier == identifier { self.videoPresentation?.dismiss() }
    }.runOnQueue(.main)

    OnDestroy {
      let file = self.filePresentation
      let video = self.videoPresentation
      DispatchQueue.main.async {
        file?.dismiss()
        video?.dismiss()
      }
    }
  }
}
