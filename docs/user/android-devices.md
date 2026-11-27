# Android devices

To install an APK on a phone connected to the local device host, install Android SDK Platform-Tools. Set `ANDROID_HOME` to the SDK directory or make `adb` available on `PATH`. Turn on USB debugging on the phone, connect it by USB, and accept the debugging prompt. The phone then appears as an install target in Solus.

Android emulator operations need the Android Emulator package and Android SDK Command-line Tools. An SSH device host needs all three packages to make Android devices available.
