/** Raw browser source avoids tsx name-preservation helpers inside serialized callbacks. */
export const readinessScript = `(view) => {

const state = window;
const stats = { listingRequests: 0, listingPaths: {}, longTasksMs: [] };
state.fdrivePerfStats = stats;
if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) stats.longTasksMs.push(entry.duration);
  }).observe({ type: "longtask", buffered: true });
}
let scheduled = false;
let responseEnd;
performance.setResourceTimingBufferSize(10000);
function observeReady() {
  if (scheduled || state.fdrivePerfReady !== undefined) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const row = document.querySelector(
      '[data-slot="file-' + view + '"] [data-path="/flat-10k/00000.bin"]' ,
    );
    if (!(row instanceof HTMLElement)) return;
    const rect = row.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom <= 0 ||
      rect.top >= innerHeight
    )
      return;
    if (responseEnd === undefined || responseEnd <= 0) return;
    state.fdrivePerfReady = performance.now() - responseEnd;
    mutations.disconnect();
  });
}
const mutations = new MutationObserver(observeReady);
mutations.observe(document, { childList: true, subtree: true, attributes: true });
const resources = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const url = new URL(entry.name);
    if (url.pathname !== "/api/v1/fs/list") continue;
    const path = url.searchParams.get("path") ?? "missing";
    if (
      path === "/flat-10k" &&
      responseEnd === undefined &&
      entry instanceof PerformanceResourceTiming
    )
      responseEnd = entry.responseEnd;
    stats.listingRequests++;
    stats.listingPaths[path] = (stats.listingPaths[path] ?? 0) + 1;
  }
  observeReady();
});
resources.observe({ type: "resource", buffered: true });
observeReady();
}
`;
