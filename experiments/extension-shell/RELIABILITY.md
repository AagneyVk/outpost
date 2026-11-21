# Relay reliability and health checks

The default Wisp relay is an external public service; OUTPOST does not operate it or guarantee its availability, capacity, privacy policy or abuse response. It can see destination metadata and plaintext HTTP. HTTPS uses the guest browser's TLS stack. The current extension offers a user-initiated save and restart after a disconnect. It does not automatically retry interrupted requests, because a request may already have been processed by the destination. A synthetic test saw the interrupted POST sent only once and verified session restoration after restart. This does not cover every failure.

An optional diagnostic probes WSS connectivity, establishes a separate certificate-verified TLS connection through Wisp to `example.com`, and checks an HTTPS response. It sends no workspace cookies. For example, from the repository root:

```powershell
node --use-system-ca tools/wisp-health.mjs wss://wisp.mercurywork.shop/ --samples 3 --interval-ms 1000
node --test tools/wisp-health.test.mjs
```

Three samples passed from one machine in a recent test. A few samples are not an uptime measurement, and Node's trust configuration can differ from Gecko's. URL query values are omitted from the diagnostic output, but relay operators and destination sites can still observe network metadata. Run only against services you are authorized to use.

A meaningful production reliability commitment needs an operated service with capacity and abuse controls, authenticated monitoring from multiple locations, measured availability and recovery times, alerting and an on-call response, a privacy and retention policy, and tested failover that does not replay non-idempotent actions. It also needs a stated service objective and a sufficiently long measurement window. None of these is established by this preview or its local probe.
