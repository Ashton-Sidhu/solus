# Rate limit release

Provider adapters retain structured reset timestamps on rate-limit events, including windows that the usage meters do not recognize. They do not infer reset dates from error text or invent a retry time.

The usage store keeps raw provider quota data from stream updates and polled reads. The control plane uses this cache only when a rate-limit event has no reset timestamp. It adds the Codex two-minute retry buffer once, before publishing the limit and recording the session gate. Queue readiness, release timers, and client countdowns therefore use the same release time. A later quota refresh does not change that recorded deadline.

An unknown reset creates no release timer. A queued prompt stays held until the user sends or discards it. A known reset releases a queued prompt; it does not answer an undecided rate-limit card for the user.

This behavior runs on the shared host for desktop, web, and mobile clients. Claude uses its provider reset without the Codex buffer.
