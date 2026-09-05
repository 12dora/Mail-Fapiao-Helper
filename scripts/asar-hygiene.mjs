// What a production app.asar must and must not contain (CODE-04).
//
// Kept apart from verify-release-artifacts.mjs so the rule itself can be unit
// tested without fabricating a whole release/ tree: the checks there only run
// after a real electron-builder pass.

/** Development leftovers that must never reach a user's machine. */
export const BANNED_ASAR_ENTRIES = [
  { pattern: /^gui-design\/tests(\/|$)/, label: 'test suite (gui-design/tests)' },
  { pattern: /(^|\/)devFakeBackend\.js(\.map)?$/, label: 'dev fake backend (devFakeBackend.js)' },
  // The renderer ships as a bundle. Its TypeScript sources and the sourcemaps
  // `npm run dev:renderer` leaves behind are development leftovers: a
  // production build never generates them, and since it now also wipes
  // gui-design/dist first, a stale one can no longer ride along.
  { pattern: /^gui-design\/src(\/|$)/, label: 'renderer sources (gui-design/src)' },
  { pattern: /^gui-design\/.*\.map$/, label: 'renderer sourcemaps (gui-design/**/*.map)' },
];

/**
 * The renderer entry point and its bundle.
 *
 * Without this list every other check passes on a package that cannot start:
 * they all look for things that must NOT be there.
 */
export const REQUIRED_ASAR_ENTRIES = [
  'gui-design/index.html',
  'gui-design/dist/app.js',
  'gui-design/dist/app.css',
];

/**
 * @param {string[]} entries every path inside the asar, '/'-separated.
 * @returns {{ errors: string[], notes: string[] }}
 */
export function auditAsarEntries(entries) {
  const errors = [];
  const notes = [];

  for (const { pattern, label } of BANNED_ASAR_ENTRIES) {
    const hits = entries.filter((entry) => pattern.test(entry));
    if (hits.length > 0) {
      const shown = hits.slice(0, 5).join(', ');
      errors.push(
        `production app.asar still contains the ${label}: ${shown}${hits.length > 5 ? ` (+${hits.length - 5} more)` : ''}`,
      );
    }
  }

  const present = new Set(entries);
  const missing = REQUIRED_ASAR_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length > 0) {
    errors.push(
      `production app.asar is missing the renderer: ${missing.join(', ')} — the app window would load nothing`,
    );
  } else {
    notes.push('app.asar carries the renderer entry (index.html + dist/app.js + dist/app.css)');
  }

  notes.push(`app.asar carries ${entries.length} entries, free of test code and renderer sources`);
  return { errors, notes };
}
