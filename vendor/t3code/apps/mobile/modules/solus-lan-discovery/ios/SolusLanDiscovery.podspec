Pod::Spec.new do |s|
  s.name           = 'SolusLanDiscovery'
  s.version        = '1.0.0'
  s.summary        = 'Local network host discovery for the Solus mobile app.'
  s.description    = 'Lists the IPv4 local network interfaces and exchanges one round of UDP datagrams.'
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
