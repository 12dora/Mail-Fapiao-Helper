// Electron 42's main-process "electron" module is CJS with dynamic exports —
// ESM named imports fail ("does not provide an export named 'BrowserWindow'")
// and ESM default-import yields the launcher path stub, not the API. Going
// through createRequire forces the proper main-process module.
import { createRequire } from 'node:module';
import type * as ElectronAPI from 'electron';

const require = createRequire(import.meta.url);

export const electron: typeof ElectronAPI = require('electron');
export type { ElectronAPI };
