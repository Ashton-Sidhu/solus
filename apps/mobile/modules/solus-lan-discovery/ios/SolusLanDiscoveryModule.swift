import Darwin
import ExpoModulesCore

/// The datagram half of LAN discovery (`@solus/contracts/lan-discovery`).
/// The protocol lives in TypeScript; this module only lists the local network
/// interfaces and sends one packet to many addresses, then collects the
/// answers for a fixed window.
public class SolusLanDiscoveryModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SolusLanDiscovery")

    Function("ipv4Interfaces") { () -> [[String: String]] in
      localInterfaces()
    }

    AsyncFunction("exchange") { (text: String, addresses: [String], port: Int, windowMs: Int) -> [[String: String]] in
      try exchange(text: text, addresses: addresses, port: UInt16(clamping: port), windowMs: windowMs)
    }.runOnQueue(DispatchQueue.global(qos: .userInitiated))
  }
}

/// Wi-Fi and wired interfaces only: cellular, VPN tunnels, and Apple's
/// peer-to-peer links never reach a host on the local network.
private func localInterfaces() -> [[String: String]] {
  var head: UnsafeMutablePointer<ifaddrs>?
  guard getifaddrs(&head) == 0, let first = head else { return [] }
  defer { freeifaddrs(head) }
  var result: [[String: String]] = []
  for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
    let entry = pointer.pointee
    let flags = Int32(entry.ifa_flags)
    guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0,
          let address = entry.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
          let netmask = entry.ifa_netmask else { continue }
    let name = String(cString: entry.ifa_name)
    if ["pdp_ip", "utun", "ipsec", "awdl", "llw", "ap"].contains(where: { name.hasPrefix($0) }) { continue }
    result.append(["address": ipv4String(address), "netmask": ipv4String(netmask)])
  }
  return result
}

private func ipv4String(_ address: UnsafeMutablePointer<sockaddr>) -> String {
  address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { pointer in
    var addr = pointer.pointee.sin_addr
    var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
    inet_ntop(AF_INET, &addr, &buffer, socklen_t(INET_ADDRSTRLEN))
    return String(cString: buffer)
  }
}

private struct SocketError: Error, CustomStringConvertible {
  let description: String
}

private func exchange(text: String, addresses: [String], port: UInt16, windowMs: Int) throws -> [[String: String]] {
  let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
  guard fd >= 0 else { throw SocketError(description: "Could not open a UDP socket (\(errno)).") }
  defer { close(fd) }
  var enabled: Int32 = 1
  setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &enabled, socklen_t(MemoryLayout<Int32>.size))

  var local = sockaddr_in()
  local.sin_family = sa_family_t(AF_INET)
  local.sin_addr.s_addr = INADDR_ANY
  local.sin_port = 0
  let bound = withUnsafePointer(to: &local) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
  }
  guard bound == 0 else { throw SocketError(description: "Could not bind a UDP socket (\(errno)).") }

  // A broadcast without the multicast entitlement fails with EHOSTUNREACH;
  // the unicast sweep beside it still reaches the hosts.
  let payload = Array(text.utf8)
  for address in addresses {
    var target = sockaddr_in()
    target.sin_family = sa_family_t(AF_INET)
    target.sin_port = port.bigEndian
    guard inet_pton(AF_INET, address, &target.sin_addr) == 1 else { continue }
    _ = withUnsafePointer(to: &target) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        sendto(fd, payload, payload.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
  }

  var answers: [[String: String]] = []
  let deadline = Date().addingTimeInterval(Double(windowMs) / 1000)
  var buffer = [UInt8](repeating: 0, count: 2048)
  while true {
    let remaining = Int32(deadline.timeIntervalSinceNow * 1000)
    if remaining <= 0 { break }
    var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
    if poll(&descriptor, 1, remaining) <= 0 { break }
    var sender = sockaddr_in()
    var senderLength = socklen_t(MemoryLayout<sockaddr_in>.size)
    let count = withUnsafeMutablePointer(to: &sender) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { recvfrom(fd, &buffer, buffer.count, 0, $0, &senderLength) }
    }
    guard count > 0, let decoded = String(bytes: buffer[0..<count], encoding: .utf8) else { continue }
    let address = withUnsafeMutablePointer(to: &sender) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { ipv4String($0) }
    }
    answers.append(["address": address, "text": decoded])
  }
  return answers
}
