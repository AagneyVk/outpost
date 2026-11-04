# OUTPOST

OUTPOST runs Gecko in your browser and uses a Wisp endpoint to reach websites. You can export the Gecko profile with a passphrase and restore it in a fresh browser.

## Run locally

Use Node.js 24 or later. Run `npm ci`, then `npm start`. Open `http://127.0.0.1:3001/`. The default network endpoint is MercuryWorkshop's public demo relay. Change it under **Network settings** if you have another Wisp endpoint.

**Files** opens immediately and stores uploads in browser storage. **Terminal** appears after you build the optional Linux runtime. On the Windows build machine, start Docker Desktop and run `npm run build:runtime` before starting OUTPOST. The generated guest filesystem and build artifacts stay local. The Linux Files panel and browser Files page have separate storage.

See [Gecko setup and profile tests](tools/gecko-wasm/README.md) and [hosting](HOSTING.md) for details. This repository is a preview. Native page zoom requires a rebuilt Gecko engine.

## GitHub Pages

The Pages demo serves the browser, tabs, history, encrypted profile exports, and browser Files. A scoped service worker sets Gecko's isolation headers and reloads the first visit once. Website connections use the selected Wisp endpoint. MercuryWorkshop operates the default public demo endpoint.

The Linux workspace runs from the local checkout after building its guest runtime. The generated guest filesystem exceeds GitHub Pages' site size limit.
