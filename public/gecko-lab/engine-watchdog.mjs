// Gecko commands run in a worker. If one stops making progress, offer a user-
// controlled recovery instead of leaving an apparently frozen page indefinitely.
export function watchEngine(gecko, { show, hide, now = () => performance.now(),
  schedule = (fn, ms) => setInterval(fn, ms), cancel = id => clearInterval(id),
  timeout = 20000, interval = 1000 } = {}) {
  let active, visible = false;
  const setVisible = value => {
    if (visible === value) return;
    visible = value;
    (value ? show : hide)();
  };
  const runCommand = gecko.runCmd.bind(gecko);
  gecko.runCmd = async item => {
    const current = { started: now() };
    active = current;
    let failed = false;
    try {
      return await runCommand(item);
    } catch (error) {
      failed = true;
      setVisible(true);
      throw error;
    } finally {
      if (active === current) {
        active = undefined;
        if (!failed) setVisible(false);
      }
    }
  };
  const timer = schedule(() => {
    if (active && now() - active.started >= timeout) setVisible(true);
  }, interval);
  return () => { cancel(timer); active = undefined; setVisible(false); };
}
