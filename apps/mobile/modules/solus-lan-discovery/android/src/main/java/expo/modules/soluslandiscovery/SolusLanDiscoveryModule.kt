package expo.modules.soluslandiscovery

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException

/**
 * The datagram half of LAN discovery (`@solus/contracts/lan-discovery`).
 * The protocol lives in TypeScript; this module only lists the local network
 * interfaces and sends one packet to many addresses, then collects the
 * answers for a fixed window.
 */
class SolusLanDiscoveryModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SolusLanDiscovery")

    Function("ipv4Interfaces") { localInterfaces() }

    AsyncFunction("exchange") { text: String, addresses: List<String>, port: Int, windowMs: Int ->
      exchange(text, addresses, port, windowMs)
    }
  }
}

/** Wi-Fi and wired interfaces only: cellular and VPN tunnels never reach a host on the local network. */
private fun localInterfaces(): List<Map<String, String>> {
  val result = mutableListOf<Map<String, String>>()
  val interfaces = NetworkInterface.getNetworkInterfaces() ?: return result
  for (networkInterface in interfaces) {
    if (!networkInterface.isUp || networkInterface.isLoopback) continue
    val name = networkInterface.name
    if (listOf("rmnet", "ccmni", "tun", "ppp", "dummy").any { name.startsWith(it) }) continue
    for (entry in networkInterface.interfaceAddresses) {
      val address = entry.address as? Inet4Address ?: continue
      result.add(mapOf("address" to address.hostAddress.orEmpty(), "netmask" to netmask(entry.networkPrefixLength.toInt())))
    }
  }
  return result
}

private fun netmask(prefix: Int): String {
  val mask = if (prefix <= 0) 0L else (0xFFFFFFFFL shl (32 - prefix)) and 0xFFFFFFFFL
  return listOf(24, 16, 8, 0).joinToString(".") { ((mask shr it) and 0xFF).toString() }
}

private fun exchange(text: String, addresses: List<String>, port: Int, windowMs: Int): List<Map<String, String>> {
  val answers = mutableListOf<Map<String, String>>()
  DatagramSocket().use { socket ->
    socket.broadcast = true
    val payload = text.toByteArray(Charsets.UTF_8)
    for (address in addresses) {
      // An unreachable address is normal in a sweep; the others still go out.
      runCatching { socket.send(DatagramPacket(payload, payload.size, InetAddress.getByName(address), port)) }
    }
    val deadline = System.currentTimeMillis() + windowMs
    val buffer = ByteArray(2048)
    while (true) {
      val remaining = deadline - System.currentTimeMillis()
      if (remaining <= 0) break
      socket.soTimeout = remaining.toInt()
      val packet = DatagramPacket(buffer, buffer.size)
      try {
        socket.receive(packet)
      } catch (_: SocketTimeoutException) {
        break
      }
      answers.add(mapOf(
        "address" to packet.address.hostAddress.orEmpty(),
        "text" to String(packet.data, packet.offset, packet.length, Charsets.UTF_8),
      ))
    }
  }
  return answers
}
