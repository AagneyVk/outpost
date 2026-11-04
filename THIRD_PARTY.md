# Experimental dependencies

v86 and its Python filesystem tools: BSD-2-Clause, Copyright (c) 2010, 2013, 2014 Fabian Hemmer. Original text: runtime/V86-LICENSE. Upstream: https://github.com/copy/v86 . Exact downloaded asset URLs, sizes and SHA-256 hashes are in vendor-manifest.json. The public compiled engine is not claimed to correspond to the source-head commit in UPSTREAM.json.

SeaBIOS/VGA firmware: upstream v86 firmware at https://github.com/copy/v86/tree/master/bios ; SeaBIOS https://www.seabios.org/ and VGABIOS https://www.nongnu.org/vgabios/ have their own LGPL/GPL terms. Firmware binaries and generated guest images are intentionally excluded from the source repository/archive. Rebuild/provide corresponding source and notices before a public binary distribution.

Alpine Linux packages retain their individual licences. The experimental image uses Alpine 3.22, Linux, Firefox ESR 140.11.0, X.Org, IceWM and CLI utilities. It is a compatibility experiment with an obsolete browser, not an approved secure browsing release. Package sources: https://gitlab.alpinelinux.org/alpine/aports . Firefox: https://www.mozilla.org/MPL/2.0/ . Linux: https://www.kernel.org/ . Preserve exact package/source versions when preparing a distribution.

Playwright Core (test-only): Apache-2.0, https://github.com/microsoft/playwright . No browser binary is redistributed; tests use the installed Edge executable.

The selected v86 experiment instead uses Debian bookworm i386 packages, including Firefox ESR 153.6 and Chromium 156 from Debian security, plus an Alpine-built Linux 6.12.115 kernel. These packages retain their individual licences. Sources: https://sources.debian.org/ , https://security.debian.org/ and https://gitlab.alpinelinux.org/alpine/aports . The obsolete-browser warning above applies to the original Alpine experiment, not every 32-bit distribution build. Public release requires exact package inventories, corresponding source and required notices; the generated runtime is currently a local feasibility build.

Xterm.js and xterm-pty retain their MIT licences in the installed packages. The extracted v86 network source under vendor/v86-network retains the upstream BSD-2-Clause licence; it is experimental and is not evidence that general Internet networking works.

The optional Node TCP relay uses `ws` and `ipaddr.js`, both MIT-licensed. Dependency versions and integrity hashes are recorded in package-lock.json. OUTPOST's own source is MIT-licensed; that does not relicense the guest operating system, firmware, browser or vendored emulator code.

The selected display path uses noVNC 1.7.0 (MPL-2.0) with Xvfb, x11vnc and LibVNCServer inside the client-local guest. `tools/vendor-display.mjs` copies noVNC's licence and author notices with its assets. X.Org and VNC components retain their individual upstream licences. The Firefox startup-code cache is generated from a fresh offline profile; only Firefox's build compatibility metadata and the allowlisted startup and script caches are copied. No NSS database, cookies, preferences, encryption keys or VM memory are copied from that build profile.

rvwasm was evaluated through its public demo using synthetic commands, with its network relay disabled. Its source is GPL-2.0-or-later with component-specific terms; https://github.com/Pogo-Bash/rvwasm/blob/main/LICENSE.md . It has not been incorporated into OUTPOST. Its default launcher explicitly disables Firefox content, RDD, socket and utility sandboxes; that is a material privacy/security limitation in addition to the measured timeout.

container2wasm/QEMU are under evaluation as a separate full-kernel alternative. https://github.com/container2wasm/container2wasm and https://github.com/ktock/qemu-wasm . Their source and guest components retain their licences. Approved converter builds mount only public tooling/test assets plus the Docker engine socket; that socket is not part of any visitor runtime.
