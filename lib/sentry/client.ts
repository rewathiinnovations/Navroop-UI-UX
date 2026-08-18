let started = false;

/** Browser init does not read env or the server runtime file. Server reporting uses the volume file. */
export function initSentryClient() {
  if (started) return;
  started = true;
}
