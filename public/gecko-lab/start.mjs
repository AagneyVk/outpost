import { clearBrowserProfiles, exportProfile, importProfile, profileLock, profileName, readBrowserSession, writeBrowserSession, readBrowserHistory, writeBrowserHistory } from './profile.mjs';
import { captureDrag } from './drag-capture.mjs';
import { optimizeWheelQueue } from './wheel-queue.mjs';

const start = document.querySelector('#start');
const startError = document.querySelector('#start-error');
const status = document.querySelector('#status');
new MutationObserver(() => {
  const message = status.textContent;
  status.hidden = !message || message === 'Search Google or enter an address.' || message.startsWith('Loaded ');
}).observe(status, { childList: true, characterData: true, subtree: true });
const canvas = document.querySelector('#surface');
captureDrag(canvas);
const address = document.querySelector('#address');
const go = document.querySelector('#go');
const welcome = document.querySelector('#welcome');
const viewport = document.querySelector('#viewport');
const scene = document.querySelector('#browser-scene');
const sceneAddress = document.querySelector('#scene-address');
const sceneView = document.querySelector('#scene-view');
function showScene(title, detail, editable = false, canView = false) {
  document.querySelector('#scene-title').textContent = title;
  document.querySelector('#scene-detail').textContent = detail;
  sceneAddress.hidden = !editable;
  sceneView.hidden = !canView;
  scene.hidden = false;
}
sceneAddress.addEventListener('click', () => { address.focus(); address.select(); });
sceneView.addEventListener('click', () => { scene.hidden = true; canvas.focus(); });
let gecko;
let navigation;
let toolsWindow;
document.querySelector('#workspace-tools').addEventListener('click', event => {
  const link = event.target.closest('a');
  if (!link) return;
  event.preventDefault();
  if (toolsWindow && !toolsWindow.closed) {
    toolsWindow.postMessage({ outpostTool: new URL(link.href).searchParams.get('tool') }, location.origin);
    toolsWindow.focus();
  } else {
    toolsWindow = window.open(link.href, link.target);
  }
});
const back = document.querySelector('#back');
const forward = document.querySelector('#forward');
const reload = document.querySelector('#reload');
const zoomOut = document.querySelector('#zoom-out');
const zoomIn = document.querySelector('#zoom-in');
const zoomReset = document.querySelector('#zoom-reset');
const historyDialog = document.querySelector('#history-dialog');
const historyList = document.querySelector('#history-list');
let stack = [];
const visits = [];
let historyWrite = Promise.resolve();
const clearHistory = document.querySelector('#clear-history');

function recordVisit(url) {
  visits.push(url);
  historyWrite = historyWrite.then(() => writeBrowserHistory(url)).catch(error => {
    status.textContent = 'History could not be saved. ' + error.message;
  });
}

clearHistory.onclick = async () => {
  if (!confirm('Clear saved browsing history from this OUTPOST profile? Open tabs will stay open.')) return;
  clearHistory.disabled = true;
  try {
    historyWrite = historyWrite.then(() => writeBrowserHistory());
    await historyWrite;
    visits.length = 0;
    historyList.replaceChildren();
  } catch (error) {
    historyWrite = Promise.resolve();
    status.textContent = error.message;
  } finally {
    clearHistory.disabled = false;
  }
};
let position = -1;
const tabs = [{ stack, position }];
let activeTab = tabs[0];
const previousFrame = document.querySelector('#previous-frame');
let pageVisible = false;
let resizing = false;

function holdFrame() {
  if (!pageVisible || !previousFrame.hidden) return;
  previousFrame.width = canvas.width;
  previousFrame.height = canvas.height;
  previousFrame.getContext('2d').drawImage(canvas, 0, 0);
  previousFrame.hidden = false;
}

function releaseFrame() {
  if (navigation || resizing) return;
  previousFrame.hidden = true;
  previousFrame.width = 0;
}
let sessionWrite = Promise.resolve();

function saveTabs() {
  const session = {
    tabs: tabs.map(tab => {
      const start = Math.max(0, tab.position - 49);
      return { stack: tab.stack.slice(start, start + 100).map(url => url.href), position: tab.position - start };
    }),
    active: tabs.indexOf(activeTab),
    zoom,
  };
  sessionWrite = sessionWrite.then(() => writeBrowserSession(session)).catch(error => {
    console.error('OUTPOST could not save tabs', error);
  });
}

async function restoreTabs() {
  const session = await readBrowserSession();
  if (!Array.isArray(session?.tabs) || !session.tabs.length || session.tabs.length > 12) return;
  try {
    const restored = session.tabs.map(tab => {
      if (!Array.isArray(tab.stack) || tab.stack.length > 100 ||
          !Number.isInteger(tab.position) || tab.position < -1 || tab.position >= tab.stack.length) throw Error();
      const stack = tab.stack.map(value => {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error();
        return url;
      });
      return { stack, position: tab.position };
    });
    if (!restored[session.active]) return;
    tabs.splice(0, tabs.length, ...restored);
    activeTab = tabs[session.active];
    stack = activeTab.stack;
    position = activeTab.position;
    if (Number.isInteger(session.zoom) && session.zoom >= 50 && session.zoom <= 200) {
      zoom = session.zoom;
      zoomReset.textContent = zoom + '%';
    }
  } catch {
    // A malformed session cannot prevent the browser from starting.
  }
}

function renderTabs() {
  const strip = document.querySelector('#tabs');
  strip.replaceChildren();
  for (const tab of tabs) {
    const item = document.createElement('div');
    item.className = 'browser-tab';
    const select = document.createElement('button');
    select.type = 'button';
    select.textContent = tab.stack[tab.position]?.hostname ?? 'New tab';
    select.setAttribute('aria-current', String(tab === activeTab));
    select.disabled = Boolean(navigation);
    select.onclick = () => switchTab(tab);
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close ' + select.textContent);
    close.disabled = tabs.length === 1 || Boolean(navigation);
    close.onclick = () => {
      const index = tabs.indexOf(tab);
      tabs.splice(index, 1);
      if (tab === activeTab) switchTab(tabs[Math.min(index, tabs.length - 1)]);
      else { renderTabs(); saveTabs(); }
    };
    item.append(select, close);
    strip.append(item);
  }
  document.querySelector('#new-tab').disabled = Boolean(navigation) || tabs.length >= 12;
}

function switchTab(tab) {
  if (navigation || tab === activeTab) return;
  activeTab.position = position;
  activeTab = tab;
  stack = tab.stack;
  position = tab.position;
  saveTabs();
  updateControls();
  if (position >= 0) navigate(stack[position], position);
  else {
    pageVisible = false;
    address.value = '';
    status.textContent = 'Search Google or enter an address.';
    showScene('New tab', 'Search Google or enter a website address.', true);
    address.focus();
  }
}

document.querySelector('#new-tab').onclick = () => {
  const tab = { stack: [], position: -1 };
  tabs.push(tab);
  switchTab(tab);
};
let zoom = 100;
let resizeSurface;
let nativeZoom = false;

function updateControls() {
  const ready = !address.disabled && !navigation;
  go.disabled = !ready;
  back.disabled = !ready || position <= 0;
  forward.disabled = !ready || position >= stack.length - 1;
  reload.disabled = !ready || position < 0;
  renderTabs();
}

back.addEventListener('click', () => navigate(stack[position - 1], position - 1));
forward.addEventListener('click', () => navigate(stack[position + 1], position + 1));
reload.addEventListener('click', () => navigate(stack[position], position));
document.querySelector('#history').addEventListener('click', () => {
  historyList.replaceChildren();
  for (const url of visits.toReversed()) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const host = document.createElement('strong');
    host.textContent = url.hostname;
    const preview = document.createElement('span');
    preview.className = 'history-preview';
    preview.textContent = url.pathname + url.search;
    button.title = url.href;
    button.append(host, preview);
    button.disabled = go.disabled;
    button.addEventListener('click', () => {
      historyDialog.close();
      navigate(url);
    });
    item.append(button);
    historyList.append(item);
  }
  historyDialog.showModal();
});

async function changeZoom(value) {
  zoom = Math.max(50, Math.min(200, value));
  zoomReset.textContent = zoom + '%';
  zoomOut.disabled = zoom === 50;
  zoomIn.disabled = zoom === 200;
  saveTabs();
  try { await resizeSurface(); }
  catch (error) { status.textContent = 'Could not change zoom: ' + error.message; }
}

zoomOut.addEventListener('click', () => changeZoom(zoom - 10));
zoomIn.addEventListener('click', () => changeZoom(zoom + 10));
zoomReset.addEventListener('click', () => changeZoom(100));

const passphrase = document.querySelector('#profile-passphrase');
const showPassphrase = document.querySelector('#show-passphrase');
const resumeBrowser = document.querySelector('#resume-browser');
function setPassphraseVisibility(visible) {
  passphrase.type = visible ? 'text' : 'password';
  showPassphrase.textContent = visible ? 'Hide passphrase' : 'Show passphrase';
  showPassphrase.setAttribute('aria-pressed', String(visible));
}
showPassphrase.onclick = () => setPassphraseVisibility(passphrase.type === 'password');
resumeBrowser.onclick = () => {
  passphrase.value = '';
  setPassphraseVisibility(false);
  start.click();
};
const profileFile = document.querySelector('#profile-file');
const exitBrowser = document.querySelector('#exit-browser');
exitBrowser.onclick = async () => {
  exitBrowser.disabled = true;
  status.textContent = 'Saving tabs and history…';
  await Promise.all([sessionWrite, historyWrite]);
  const url = new URL(location.href);
  url.hash = 'export-profile';
  history.replaceState(null, '', url);
  location.reload();
};
if (location.hash === '#export-profile') {
  history.replaceState(null, '', location.pathname + location.search);
  document.querySelector('#profile-options').open = true;
  resumeBrowser.hidden = false;
  status.textContent = 'Browser closed. Enter a passphrase and export your saved profile.';
  passphrase.focus();
}
const clearPrompt = document.querySelector('#confirm-profile-clear');
document.querySelector('#cancel-profile-clear').onclick = () => { clearPrompt.hidden = true; };
document.querySelector('#clear-profile').onclick = async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await clearBrowserProfiles();
    clearPrompt.hidden = true;
    status.textContent = 'OUTPOST browser profiles cleared from this address.';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
for (const action of ['export', 'export-clear', 'import']) {
  document.querySelector('#' + action + '-profile').addEventListener('click', async () => {
    clearPrompt.hidden = true;
    try {
      if (action !== 'import') {
        const blob = await exportProfile(passphrase.value);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'outpost-gecko.outpost';
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        status.textContent = 'Encrypted profile exported.';
        clearPrompt.hidden = action !== 'export-clear';
      } else {
        const file = profileFile.files[0];
        if (!file) throw Error('Choose an encrypted OUTPOST profile.');
        await importProfile(file, passphrase.value);
        status.textContent = 'Profile restored. Start the browser to use it.';
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      passphrase.value = '';
      setPassphraseVisibility(false);
    }
  });
}

function surfaceSize() {
  const scale = (window.devicePixelRatio || 1) * (nativeZoom ? 1 : 100 / zoom);
  return {
    width: Math.max(1, Math.round(viewport.clientWidth * scale)),
    height: Math.max(1, Math.round(viewport.clientHeight * scale)),
  };
}

Promise.all(['/workstation.html', '/build.json'].map(url => fetch(url, { method: 'HEAD' }))).then(responses => {
  const available = responses.every(response => response.ok);
  document.querySelector('#workspace-link').hidden = !available;
  document.querySelector('#workspace-tools').hidden = !available;
}).catch(() => {});

document.querySelector('#fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (error) {
    console.error(error);
  }
});

function finishNavigation(message) {
  clearTimeout(navigation.timer);
  navigation = undefined;
  status.textContent = message;
  releaseFrame();
  pageVisible = message.startsWith('Loaded ');
  if (pageVisible) scene.hidden = true;
  else showScene('Page load unconfirmed', message, true, true);
  updateControls();
}

function reportEngineMessage(message) {
  console.debug(message);
  const result = /^xul_render: load (stop|FAILED) status=(0x[0-9a-f]+).*? req=(https?:\/\/\S+)/i.exec(message);
  if (!result) return;
  if (!navigation) {
    // The shipping engine truncates the request name after 60 bytes.
    if (pageVisible && result[1] === 'stop' && result[2] === '0x00000000' && result[3].length < 60) {
      const url = URL.parse(result[3]);
      if (url && !url.username && !url.password && url.href !== stack[position]?.href) {
        stack.splice(position + 1, stack.length, url);
        activeTab.position = position = stack.length - 1;
        address.value = url.href;
        recordVisit(url);
        saveTabs();
        updateControls();
      }
    }
    return;
  }
  const requested = navigation.url.href;
  let matches = result[3] === requested ||
    (result[1] === 'stop' && result[3].length === 60 && requested.startsWith(result[3]));
  if (!matches && result[1] === 'stop' && result[2] === '0x00000000') {
    const redirected = URL.parse(result[3]);
    if (redirected && redirected.origin === navigation.url.origin && !redirected.username && !redirected.password) {
      matches = true;
      if (result[3].length < 60) navigation.finalUrl = redirected;
    }
  }
  if (!matches) return;
  const host = navigation.url.hostname;
  if (result[2] === '0x804b0003') return; // The document channel hands off to the network channel.
  if (result[2] === '0x804b0002') {
    // Redirects commonly cancel the original request before opening its replacement.
    return;
  }
  if (result[1] === 'stop' && result[2] === '0x00000000') {
    const visited = navigation.finalUrl ?? navigation.url;
    address.value = visited.href;
    if (navigation.position === undefined) {
      stack.splice(position + 1, stack.length, visited);
      position = stack.length - 1;
      recordVisit(visited);
    } else {
      position = navigation.position;
      stack[position] = visited;
    }
    activeTab.position = position;
    saveTabs();
    finishNavigation('Loaded ' + host);
  } else if (result[2] === '0x805a1ff3') {
    finishNavigation('Gecko could not verify the HTTPS certificate for ' + host + '.');
  } else {
    finishNavigation('Could not load ' + host + ' (' + result[2] + ').');
  }
}

document.querySelector('#navigation').addEventListener('submit', event => {
  event.preventDefault();
  if (go.disabled) return;
  let url;
  try {
    const value = address.value.trim();
    if (!value) return;
    if (/^https?:\/\//i.test(value)) {
      url = new URL(value);
    } else if (/^(?:localhost|\[[a-f\d:]+\]|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]\S*)?$/i.test(value)) {
      url = new URL((value.toLowerCase() === 'example.com' ? 'http://' : 'https://') + value);
    } else {
      url = new URL('https://www.google.com/search');
      url.searchParams.set('q', value);
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error();
  } catch {
    status.textContent = 'Enter an HTTP or HTTPS address without credentials.';
    return;
  }
  navigate(url);
});

async function navigate(url, targetPosition) {
  if (!url || go.disabled) return;
  address.value = url.href;
  address.blur();
  status.textContent = 'Opening ' + url.hostname + '…';
  if (pageVisible) {
    holdFrame();
  } else showScene('Opening website', url.hostname);
  navigation = {
    url,
    position: targetPosition,
    timer: setTimeout(() => finishNavigation('Gecko did not confirm the page load. Check the canvas or try again.'), 20000),
  };
  updateControls();
  try {
    await gecko.load(url.href);
    if (nativeZoom) await resizeSurface();
    canvas.focus();
  } catch (error) {
    console.error(error);
    if (navigation?.url === url) finishNavigation('Could not open ' + url.hostname);
  }
}

start.addEventListener('click', async () => {
  if (gecko) { location.reload(); return; }
  start.disabled = true;
  startError.hidden = true;
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    startError.textContent = 'Open OUTPOST at its HTTPS address or use localhost to start the browser.';
    startError.hidden = false;
    start.disabled = false;
    return;
  }

  status.textContent = 'Loading the local Gecko build…';
  welcome.hidden = true;
  viewport.hidden = false;
  showScene('Starting OUTPOST', 'Loading the browser engine on this device.');
  let releaseProfile;
  try {
    const acquired = await new Promise((resolve, reject) => {
      navigator.locks.request(profileLock, { ifAvailable: true }, lock => {
        resolve(Boolean(lock));
        if (lock) return new Promise(release => { releaseProfile = release; });
      }).catch(reject);
    });
    if (!acquired) throw Error('Close the other OUTPOST browser tab and try again.');
    const custom = document.querySelector('#relay-url').value.trim();
    const relay = custom ? new URL(custom) : new URL('/network/', location.href);
    if (!custom) relay.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (custom && (relay.protocol !== 'wss:' || relay.username || relay.password || relay.hash)) {
      throw Error('Enter a secure wss:// relay URL without credentials or a fragment.');
    }
    const { Gecko } = await import('./engine/gecko-input-v2.js');
    const initial = surfaceSize();
    gecko = new Gecko({
      canvas,
      width: initial.width,
      height: initial.height,
      wispUrl: relay.href,
      print: reportEngineMessage,
      printErr: reportEngineMessage,
      wasm: { url: new URL('./engine/gecko-input-v2.wasm.zst', import.meta.url).href, compressed: true },
      profile: profileName(),
      env: { GECKO_NOWASMJIT: '1' },
    });
    optimizeWheelQueue(gecko, canvas);
    await gecko.init();
    await restoreTabs().catch(error => console.warn('Could not restore tabs', error));
    const savedHistory = await readBrowserHistory().catch(error => {
      console.warn('Could not read history', error);
      return [];
    });
    for (const value of savedHistory) {
      try {
        const url = new URL(value);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) visits.push(url);
      } catch {}
    }
    clearHistory.disabled = false;
    // The current software paint path does not yet render native zoom correctly,
    // even when the engine advertises it. Keep the existing zoom path until the
    // renderer and restored-session startup are verified together.
    nativeZoom = false;
    let appliedScale;
    const drawSize = async () => {
      const size = surfaceSize();
      if (nativeZoom && position >= 0) {
        const scale = Math.round((window.devicePixelRatio || 1) * zoom * 10);
        if (scale !== appliedScale) {
          const result = await gecko.evalChrome('outpost:zoom:' + scale);
          if (result !== 'ok') throw Error('Gecko rejected native zoom.');
          appliedScale = scale;
        }
      }
      if (size.width !== canvas.width || size.height !== canvas.height) {
        await gecko.resize(size.width, size.height);
      }
    };
    let resizePending = false;
    resizeSurface = async () => {
      resizePending = true;
      if (resizing) return;
      resizing = true;
      holdFrame();
      try {
        while (resizePending) {
          resizePending = false;
          await drawSize();
        }
      } finally {
        resizing = false;
        releaseFrame();
      }
    };
    await resizeSurface();
    const resize = () => resizeSurface().catch(console.error);
    new ResizeObserver(resize).observe(viewport);
    window.addEventListener('resize', resize);
    status.textContent = 'Search Google or enter an address.';
    showScene('Ready to browse', 'Search Google or enter a website address.', true);
    address.disabled = false;
    exitBrowser.disabled = false;
    document.querySelector('#tab-strip').hidden = false;
    updateControls();
    zoomOut.disabled = zoom === 50;
    zoomIn.disabled = zoom === 200;
    zoomReset.disabled = false;
    if (position >= 0) navigate(stack[position], position);
    else address.focus();
  } catch (error) {
    console.error(error);
    if (gecko) {
      gecko.destroy();
      start.textContent = 'Reload OUTPOST';
    } else {
      releaseProfile?.();
    }
    viewport.hidden = true;
    welcome.hidden = false;
    start.disabled = false;
    const reason = error.message || 'Reload OUTPOST and try again.';
    status.textContent = reason;
    startError.textContent = reason;
    startError.hidden = false;
  }
});
