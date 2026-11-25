// Builds a separate, clearly marked research preview. It never modifies an
// existing extension directory or the user's previous plaintext profile.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeInventory, inventoryName } from '../extension-shell/inventory.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const flag = process.argv.indexOf('--out');
if (flag >= 0 && !process.argv[flag + 1]) throw Error('--out requires a new directory');
const destination = path.resolve(flag >= 0 ? process.argv[flag + 1] : path.join(root, '../outpost-encrypted-live-preview'));
await promisify(execFile)(process.execPath, [path.join(root, 'experiments/extension-shell/build.mjs'), '--out', destination], { cwd: root });
const liveDir = path.join(destination, 'gecko-lab/research/encrypted-live-profile');
const memoryDir = path.join(destination, 'gecko-lab/research/memory-profile');
await fs.mkdir(liveDir, { recursive: true }); await fs.mkdir(memoryDir, { recursive: true });
for (const name of ['block-profile.mjs', 'block-store.mjs', 'block-lock.mjs', 'app-profile.mjs', 'legacy-profile.mjs'])
  await fs.copyFile(path.join(here, name), path.join(liveDir, name));
await fs.copyFile(path.join(root, 'experiments/memory-profile/memory-profile.mjs'), path.join(memoryDir, 'memory-profile.mjs'));
function replaceOnce(source, before, after, description) {
  const index = source.indexOf(before);
  if (index < 0 || index !== source.lastIndexOf(before)) throw Error('Unexpected ' + description + '.');
  return source.slice(0, index) + after + source.slice(index + before.length);
}
const htmlFile = path.join(destination, 'gecko-lab/index.html');
let html = await fs.readFile(htmlFile, 'utf8');
html = replaceOnce(html, '<button id="start" class="primary" type="button">Start browser</button>', `<div id="live-settings">
      <p><strong>Experimental encrypted profile.</strong> Test with synthetic data only. Browser Files and Linux are separate. Back up before using this preview.</p>
      <label for="live-mode">Encrypted profile</label>
      <select id="live-mode"><option value="open">Unlock existing</option><option value="create">Create new</option></select>
      <label for="live-passphrase">Live profile passphrase</label>
      <input id="live-passphrase" type="password" autocomplete="off" minlength="8" maxlength="1024">
      <label for="live-confirm">Confirm passphrase for a new profile or import</label>
      <input id="live-confirm" type="password" autocomplete="off" minlength="8" maxlength="1024">
      <button id="show-live-passphrase" type="button" aria-pressed="false">Show live passphrase</button>
    </div>
    <button id="start" class="primary" type="button">Start encrypted browser</button>`, 'startup UI');
html = replaceOnce(html, 'For a new export, use 8 characters with a number and symbol, or a passphrase of 16 or more characters. A longer, unique passphrase is safer against guessing. For imports, use the original passphrase. Use Exit browser to save session logins before exporting, and close other running OUTPOST browser tabs first.', 'For export, enter the live profile passphrase above and choose an export passphrase below. For import, enter and confirm a new live passphrase above and enter the original export passphrase below. Import creates a new encrypted profile and never overwrites an existing one.', 'profile instructions');
html = replaceOnce(html, 'OUTPOST does not encrypt the working profile stored in this browser, including saved website sessions. The downloaded profile export is encrypted. On a shared computer, confirm your export before clearing the local profiles; Browser Files and Linux workspaces are separate.', 'This experimental build encrypts its browser profile in local storage. A compromised computer can still capture what you type or view. Browser Files and Linux workspaces are separate and are not covered.', 'profile disclosure');
html = replaceOnce(html, 'Confirm that the encrypted file downloaded and you know its passphrase. Clearing removes all OUTPOST Gecko profiles from this browser on this address. Browser Files and Linux workspaces are separate.', 'Confirm the encrypted export downloaded, then re-enter the live passphrase above. Clearing removes this encrypted profile logically; it is not proof of forensic erasure. Other profiles, Browser Files, and Linux workspaces are separate.', 'clear disclosure');
html = replaceOnce(html, '<footer id="status" role="status" hidden></footer>', '<aside id="live-fatal" role="alert" hidden>Encrypted storage failed. Recent work may not be saved. Keep this page open to copy anything needed, and use a verified backup before restarting.</aside>\n<footer id="status" role="status" hidden></footer>', 'storage error UI');
await fs.writeFile(htmlFile, html);
await fs.appendFile(path.join(destination, 'gecko-lab/browser.css'), '\n#live-fatal { position: fixed; z-index: 8; bottom: 12px; left: 12px; right: 12px; padding: 12px; border: 2px solid white; background: #111; color: white; }\n#live-fatal[hidden] { display: none; }\n');

const startFile = path.join(destination, 'gecko-lab/start.mjs');
let start = await fs.readFile(startFile, 'utf8');
const originalImport = "import { clearBrowserProfiles, exportProfile, importProfile, profileLock, profileName, readBrowserSession, writeBrowserSession, readBrowserHistory, writeBrowserHistory, hasSessionCookieSnapshot, clearSessionCookieSnapshot } from './profile.mjs';";
const replacement = `import { profileLock } from './profile.mjs';
import { seal, unseal } from '/portable.js';
import { validExportPassphrase } from './passphrase-policy.mjs';
import { openLockedBlockTestProfile, migrateLockedBlockTestProfile, deleteLockedBlockTestProfile } from './research/encrypted-live-profile/block-lock.mjs';
import { encryptedAppProfile } from './research/encrypted-live-profile/app-profile.mjs';
const liveName = 'outpost-live-test-preview';
const legacyFingerprint = 'ebd6c75179152624d9644865e11792ed25cadc714d9e0985f412baf9c637a086';
let encryptedHandle;
const livePassInput = document.querySelector('#live-passphrase'), liveConfirmInput = document.querySelector('#live-confirm');
const liveMode = document.querySelector('#live-mode'), liveShow = document.querySelector('#show-live-passphrase');
liveShow.onclick = () => { const visible = livePassInput.type === 'password'; livePassInput.type = visible ? 'text' : 'password'; liveConfirmInput.type = visible ? 'text' : 'password'; liveShow.textContent = visible ? 'Hide live passphrase' : 'Show live passphrase'; liveShow.setAttribute('aria-pressed', String(visible)); };
function clearLivePassphrases() { livePassInput.value = ''; liveConfirmInput.value = ''; livePassInput.type = 'password'; liveConfirmInput.type = 'password'; liveShow.textContent = 'Show live passphrase'; liveShow.setAttribute('aria-pressed', 'false'); }
function livePassphrase(creating = false) { const pass = livePassInput.value; if (!validExportPassphrase(pass)) throw Error('Use 8 characters with a number and symbol, or a passphrase of at least 16 characters.'); if (creating && pass !== liveConfirmInput.value) throw Error('Live passphrases do not match.'); return pass; }
const { readBrowserSession, writeBrowserSession, readBrowserHistory, writeBrowserHistory, hasSessionCookieSnapshot, clearSessionCookieSnapshot } = encryptedAppProfile(() => encryptedHandle?.live);
async function exportProfile(passphrase) { if (!validExportPassphrase(passphrase)) throw Error('Choose an export passphrase of 8 characters with a number and symbol, or at least 16 characters.'); let handle; try { handle = await openLockedBlockTestProfile(liveName, livePassphrase(), 'open'); return await handle.live.exportLegacy(passphrase, legacyFingerprint, seal); } finally { if (handle) await handle.close(); clearLivePassphrases(); } }
async function importProfile(file, passphrase) { let handle; try { handle = await migrateLockedBlockTestProfile(liveName, livePassphrase(true), file, passphrase, legacyFingerprint, unseal); await handle.close(); handle = null; liveMode.value = 'open'; } finally { if (handle) await handle.close(); clearLivePassphrases(); } }
async function clearBrowserProfiles() { try { await deleteLockedBlockTestProfile(liveName, livePassphrase()); } finally { clearLivePassphrases(); } }`;
start = replaceOnce(start, originalImport, replacement, 'profile integration');
start = replaceOnce(start, '    gecko = new Gecko({', `    try {
      encryptedHandle = await openLockedBlockTestProfile(liveName, livePassphrase(liveMode.value === 'create'), liveMode.value);
      encryptedHandle.live.onFatal(() => {
        document.querySelector('#live-fatal').hidden = false;
        address.disabled = true; go.disabled = true;
      });
    } finally { clearLivePassphrases(); }
    gecko = new Gecko({`, 'encrypted startup');
start = replaceOnce(start, '      profile: inspectionProfile ?? profileName(),', '      profile: encryptedHandle.live,', 'profile mount');
start = replaceOnce(start, "status.textContent = 'OUTPOST browser profiles cleared from this address.';", "status.textContent = 'Encrypted profile cleared from this extension. Other profiles and files are separate.';", 'encrypted clear status');
start = replaceOnce(start, "  } catch (error) {\n    console.error('OUTPOST could not start the browser.');", "  } catch (error) {\n    clearLivePassphrases();\n    if (encryptedHandle) { await encryptedHandle.close().catch(() => {}); encryptedHandle = undefined; }\n    console.error('OUTPOST could not start the browser.');", 'startup failure cleanup');
start = replaceOnce(start, 'if (resumingAfterRelay && relaySettingsRestored) start.click();', "if (resumingAfterRelay && relaySettingsRestored) { status.textContent = 'Enter your live profile passphrase to restart.'; liveMode.value = 'open'; livePassInput.focus(); }", 'encrypted relay restart');
await fs.writeFile(startFile, start);
await fs.unlink(path.join(destination, inventoryName));
const digest = await writeInventory(destination);
console.log('Built experimental encrypted-profile preview at ' + destination);
console.log('Build inventory SHA-256: ' + digest);
