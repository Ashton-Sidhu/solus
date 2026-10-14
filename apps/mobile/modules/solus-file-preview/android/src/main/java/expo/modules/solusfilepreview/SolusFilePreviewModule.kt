// Adapted from T3 Code apps/mobile/modules/t3-native-controls/android/src/main/java/expo/modules/t3nativecontrols/T3NativeControlsModule.kt (MIT, see apps/mobile/UPSTREAM.md).
// Only `openFile`: a downloaded document opens in another app's viewer.
package expo.modules.solusfilepreview

import android.content.Intent
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URI

class SolusFilePreviewModule : Module() {
  private var filePreviewPromise: Promise? = null

  @Suppress("TooGenericExceptionCaught") // Clear the pending promise before rethrowing.
  override fun definition() = ModuleDefinition {
    Name("SolusFilePreview")

    // The file must be in the app cache: expo-file-system's provider shares that folder.
    AsyncFunction("openFile") { uri: String, mimeType: String, promise: Promise ->
      check(filePreviewPromise == null) { "A document viewer is already open." }
      val activity = appContext.currentActivity ?: error("The app is not active.")
      val file = File(URI(uri)).canonicalFile
      require(file.isFile) { "The file is no longer available." }
      val contentUri = FileProvider.getUriForFile(
        activity,
        "${activity.packageName}.FileSystemFileProvider",
        file
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(contentUri, mimeType)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      filePreviewPromise = promise
      try {
        activity.startActivityForResult(intent, REQUEST_CODE)
      } catch (error: Exception) {
        filePreviewPromise = null
        throw error
      }
    }

    OnActivityResult { _, (requestCode) ->
      if (requestCode == REQUEST_CODE) {
        filePreviewPromise?.resolve(null)
        filePreviewPromise = null
      }
    }
  }

  private companion object {
    const val REQUEST_CODE = 7343
  }
}
