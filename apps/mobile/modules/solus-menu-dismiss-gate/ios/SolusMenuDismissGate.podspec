Pod::Spec.new do |s|
  s.name           = 'SolusMenuDismissGate'
  s.version        = '1.0.0'
  s.summary        = 'Keeps the tap that dismisses a native menu from pressing the view under it.'
  s.description    = 'A window gesture recognizer that tells React Native touch handlers to ignore touches while a UIKit context menu is open.'
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
