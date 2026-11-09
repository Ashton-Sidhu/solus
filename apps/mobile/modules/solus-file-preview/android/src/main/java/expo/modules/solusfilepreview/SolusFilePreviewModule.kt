// Adapted from T3 Code apps/mobile/modules/t3-native-controls/android/src/main/java/expo/modules/t3nativecontrols/T3NativeControlsModule.kt (MIT, see apps/mobile/UPSTREAM.md).
// `openFile`, a downloaded document in another app's viewer, and
// `saveImageToLibrary`, an image added to Pictures/Solus.
package expo.modules.solusfilepreview

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.annotation.RequiresApi
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

    AsyncFunction("saveImageToLibrary") { uri: String, mimeType: String, name: String ->
      val context = appContext.reactContext ?: error("The app is not active.")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        saveImageToPictures(context, Uri.parse(uri), mimeType, name)
      } else {
        error("Saving images needs Android 10 or later.")
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

// Android 10+ lets apps add their own media without a storage permission.
@RequiresApi(Build.VERSION_CODES.Q)
private fun saveImageToPictures(context: Context, source: Uri, mimeType: String, name: String) {
  val resolver = context.contentResolver
  val values = ContentValues().apply {
    put(MediaStore.Images.Media.DISPLAY_NAME, name)
    put(MediaStore.Images.Media.MIME_TYPE, mimeType)
    put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/Solus")
    put(MediaStore.Images.Media.IS_PENDING, 1)
  }
  val target = resolver.insert(
    MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
    values
  ) ?: error("Could not create the image in Pictures.")
  runCatching {
    val input = resolver.openInputStream(source) ?: error("The image is no longer available.")
    input.use { from ->
      val output = resolver.openOutputStream(target) ?: error("Could not write the image.")
      output.use { from.copyTo(it) }
    }
    resolver.update(
      target,
      ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) },
      null,
      null
    )
  }.onFailure { resolver.delete(target, null, null) }.getOrThrow()
}
