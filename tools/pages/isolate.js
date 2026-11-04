if (!crossOriginIsolated && 'serviceWorker' in navigator) {
  const script = new URL('./isolation-worker.js', document.currentScript.src);
  const refresh = () => {
    if (!sessionStorage.getItem('outpost-isolation-reloaded')) {
      sessionStorage.setItem('outpost-isolation-reloaded', '1');
      location.reload();
    }
  };
  navigator.serviceWorker.addEventListener('controllerchange', refresh, { once: true });
  navigator.serviceWorker.register(script).then(() => {
    if (navigator.serviceWorker.controller) refresh();
  }).catch(console.error);
} else if (crossOriginIsolated) {
  sessionStorage.removeItem('outpost-isolation-reloaded');
}
