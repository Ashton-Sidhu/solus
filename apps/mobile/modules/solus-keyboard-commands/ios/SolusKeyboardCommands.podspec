Pod::Spec.new do |s|
  s.name           = 'SolusKeyboardCommands'
  s.version        = '1.0.0'
  s.summary        = 'Hardware keyboard commands for the Solus mobile app.'
  s.description    = 'A view that offers UIKeyCommands to the responder chain and reports which one fired.'
  s.author         = 'Solus'
  s.homepage       = 'https://solus.sh'
  s.license        = 'BUSL-1.1'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
