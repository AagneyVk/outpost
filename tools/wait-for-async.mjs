// Playwright waitForFunction treats an async predicate's Promise as truthy.
// Poll the resolved result from the test process instead.
export async function waitForAsync(check, { timeout = 30000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, interval));
  } while (Date.now() < deadline);
  throw Error('Timed out waiting for an asynchronous test condition.');
}
