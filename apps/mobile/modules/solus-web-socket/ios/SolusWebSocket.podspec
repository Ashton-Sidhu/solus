Pod::Spec.new do |s|
  s.name           = 'SolusWebSocket'
  s.version        = '1.0.0'
  s.summary        = 'A WebSocket client with permessage-deflate for the Solus mobile app.'
  s.description    = 'React Native ships SocketRocket on iOS, which never negotiates compression. This module dials the host through URLSessionWebSocketTask, which offers permessage-deflate on every handshake.'
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
