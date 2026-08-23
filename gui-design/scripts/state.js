/* 发票助手桌面端壳层状态。 */

// Initialise the shared scratch object early so async code that fires before
// wire() / DOMContentLoaded (e.g. config readiness resolvers) has a target.
const state = window.FPH || {};
window.FPH = state;

export function getState() {
    return state;
}

export function exposeCompatibilityApi(api) {
    Object.assign(state, api);
    return state;
}
