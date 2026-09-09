# Tunnel status at startup

Tunnel recovery runs in the background on desktop and standalone hosts. An offline
tunnel must not prevent the host or local workspace from starting.

Settings shows the tunnel status in Solus cloud. An offline tunnel must not be
described as reachable. If link verification or connector startup fails, Settings
shows the failure and confirms that Solus can still be used locally. The saved link
is kept. Restarting Solus retries link verification. A running connector retains
its existing automatic retry behavior.

The shared Settings description applies to desktop, web, and mobile clients where
the existing local-owner access rules permit tunnel management. A client whose
only route is the offline tunnel still needs a working route to reach the host.
