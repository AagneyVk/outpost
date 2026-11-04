# Network transport

Linux, Firefox, SSH encryption, application execution and workspace encryption run on the visitor's computer. A same-origin Wisp v1 relay carries TCP bytes to public remote endpoints. It does not execute the workstation or terminate guest HTTPS/SSH encryption. The operator sees connection destinations, timing and traffic volume; destination websites see the relay's network address. This is not an anonymity service.

`relay.mjs` runs with the asset server and binds through its loopback listener. No visitor account is needed. Default outbound ports are 22, 80 and 443. DNS results are checked against nonpublic address ranges and the validated literal address is used for the socket, avoiding a second DNS lookup. Private, loopback, link-local and multicast destinations are rejected. Foreign WebSocket origins, oversized messages and excess streams are rejected; socket queues are bounded. The guest Wisp adapter obtains DNS through its configured DNS-over-HTTPS provider.

The relay tests establish an actual certificate-verified HTTPS connection and reject private destinations, including IPv4-mapped IPv6, and foreign origins. The guest curl test also reached HTTP/2 200. This development computer intercepts TLS using an antivirus CA; the synthetic curl test explicitly loads its existing public trust bundle. Certificate verification stays enabled. That bundle is not part of the shipped runtime, not added automatically to Firefox, and not a reason to disable certificate checking.

No public service has been provisioned or advertised. The server is loopback-only. Publishing the interface requires HTTPS/WSS, the correct allowed origin, operator-controlled access/rate limits and a defined bandwidth/abuse policy. Free static hosting alone cannot supply arbitrary TCP transport. A free operator-controlled gateway can avoid visitor subscriptions, but unlimited zero-cost bandwidth and availability are not guaranteed.

Private-network devices need a specifically authorized gateway/route or cooperating peer. The public relay deliberately cannot scan a private network. Arbitrary UDP, direct peer connectivity and custom SSH ports are not implemented by this prototype. This is a current product limitation, not hidden behind an account signup.
# Optional SOCKS egress

Set `OUTPOST_SOCKS_PORT` to the port of a trusted SOCKS5 listener bound to `127.0.0.1` on the relay host. OUTPOST validates destination addresses before connecting and passes the validated IP to SOCKS. DNS resolution still occurs on the relay host. A SOCKS failure closes the stream without falling back to direct egress. Gecko still validates destination TLS.
