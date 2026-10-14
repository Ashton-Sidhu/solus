Pod::Spec.new do |s|
  s.name           = 'SolusFilePreview'
  s.version        = '1.0.0'
  s.summary        = 'Quick Look previews of images and documents, and AVKit video playback, for the Solus mobile app.'
  s.description    = 'Downloads a file to a temporary folder and shows it, or a gallery of files, in QLPreviewController.'
  s.author         = 'Solus'
  s.homepage       = 'https://solus.sh'
  s.license        = 'MIT'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
