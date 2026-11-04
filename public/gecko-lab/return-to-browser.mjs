document.querySelector('[data-return-browser]')?.addEventListener('click', event => {
  try {
    const browser = window.opener;
    if (!browser || browser.closed || browser.location.origin !== location.origin) return;
    event.preventDefault();
    browser.focus();
  } catch {
    // Use the normal browser link when this page was opened independently.
  }
});
