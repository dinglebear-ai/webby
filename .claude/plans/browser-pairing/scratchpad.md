# Browser pairing scratchpad

- Slice boundary: browser pairing and versioned Phoenix Channel protocol only. No extension scanner or MCP endpoint.
- Phoenix 1.8 socket origin checks must remain enabled; extension origins are validated again from connect metadata.
- Durable browser identity stores only an Ed25519 public key. Challenges are random, instance-bound, single-use, and expire after 60 seconds.
- Pairing requests expire after five minutes and require local LiveView approval.
- The logical envelope is transport-neutral and rejects unknown types or protocol versions.
- Avoid adding an auth dependency: OTP `:crypto` supports Ed25519 verification.
- Phoenix intentionally does not expose the Origin header to `connect/3`; strict origin validation stays at the transport check. Local consent displays both claimed extension ID and the authentication-key fingerprint.
- Pairing resolution uses a private PubSub topic per claimed extension identity and a pairing-ID status query for service-worker restart recovery.
