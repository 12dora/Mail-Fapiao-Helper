import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FAULT_TOKEN = 'mail-fapiao-helper-test-faults';
const PACKAGE_NAME = 'mail-fapiao-helper';

/** 本模块所在目录（编译后为 `dist/util`）。 */
function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** 包根：`dist/util` → 上两级。绝不使用 `process.cwd()`（Electron 会把 CLI cwd 指到 dataDir）。 */
function packageRoot(): string {
  return path.resolve(moduleDir(), '..', '..');
}

function isAsarModulePath(modulePath: string): boolean {
  // app.asar / app.asar.unpacked 均视为已打包。
  if (modulePath.includes(`${path.sep}app.asar${path.sep}`)
    || modulePath.includes(`${path.sep}app.asar.unpacked${path.sep}`)
    || modulePath.includes('/app.asar/')
    || modulePath.includes('/app.asar.unpacked/')) {
    return true;
  }
  // Windows asar 路径有时是 app.asar\...
  if (/\.asar([\\/]|$)/i.test(modulePath) && /app\.asar/i.test(modulePath)) {
    return true;
  }
  return false;
}

/**
 * 发布构建写入的 `dist/buildInfo.js` 是否声明 `production: true`。
 * 读失败或内容无法判定时 fail-closed：视为生产（禁止测试钩子）。
 * 只认可执行绑定（export/const），忽略注释里的文字。
 */
function productionBuildMarkerPresent(): boolean {
  const buildInfoPath = path.resolve(moduleDir(), '..', 'buildInfo.js');
  try {
    if (!fs.existsSync(buildInfoPath)) return false;
    let text = fs.readFileSync(buildInfoPath, 'utf8');
    // 去掉块注释与行注释，避免注释中的 “production true” 误触。
    text = text.replace(/\/\*[\s\S]*?\*\//g, '\n').replace(/^\s*\/\/.*$/gm, '\n');
    // 仅匹配绑定：export const production = true / production: true（对象字面量）
    return /(?:^|[\s{,;])(?:export\s+)?(?:const\s+)?production\s*[:=]\s*true\b/m.test(text);
  } catch {
    // 存在但不可读：不能证明非生产 → 按生产处理。
    return true;
  }
}

/**
 * 包根是否仍是「源码检出 / 开发树」：
 * - package.json name 匹配；
 * - 存在 `src/util/testFaults.ts`（纯 dist 出货树、asar 内都没有 TypeScript 源）。
 *
 * 不依赖 cwd，也不把「sentinel 是否存在」当作唯一开发证明（sentinel 另作 fault 开关）。
 */
function isSourceDevelopmentTree(root: string): boolean {
  try {
    const pkgPath = path.join(root, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: unknown };
    if (pkg.name !== PACKAGE_NAME) return false;
    // 源码树标记：tsc 产物 alone 的出货树不会带上 .ts 源文件。
    if (!fs.existsSync(path.join(root, 'src', 'util', 'testFaults.ts'))) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 能否证明当前是开发/测试运行时。默认 **否**（fail closed）。
 *
 * 必须同时满足：
 * 1. 模块路径不在 `app.asar` / `app.asar.unpacked` 内；
 * 2. `dist/buildInfo.js` 未声明 `production: true`（发布脚本在 pack/dist 前写入）；
 * 3. 包根仍是源码检出（`package.json` + `src/util/testFaults.ts`）。
 *
 * 因此：
 * - 打包 Electron（asar）→ false
 * - 独立 `mfh` CLI 的 release 构建（buildInfo.production=true）→ false
 * - 仅含 dist 的抽出出货树（无 src）→ false
 * - 本地 `npm run build` + 完整 checkout（`gui-design/tests` 回归）→ true
 */
export function isDevelopmentRuntime(): boolean {
  try {
    const modulePath = fileURLToPath(import.meta.url);
    if (isAsarModulePath(modulePath)) return false;
    if (productionBuildMarkerPresent()) return false;
    if (!isSourceDevelopmentTree(packageRoot())) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 是否应按「生产边界」处理测试钩子 / mock OCR。
 *
 * 历史名保留给 registry 等调用方：语义为 **非开发树**（含 asar、release CLI、
 * 抽出的出货树）。不得仅靠 asar 路径判断——独立 `mfh` bin 与抽出树路径不含 asar。
 */
export function isPackagedRuntime(): boolean {
  return !isDevelopmentRuntime();
}

/**
 * Sentinel 锚定在**本包安装根**（dist/util → ../..），绝不使用 process.cwd()。
 * Electron 把 CLI 的 cwd 设为 dataDir，用户可在 dataDir 下伪造
 * `gui-design/tests/.fault-injection-enabled`；打包产物又排除了 `gui-design/tests/**`，
 * 因此在 asar / 正式出货树内该路径不可能被用户写入。
 */
function faultSentinelPath(): string {
  return path.resolve(packageRoot(), 'gui-design', 'tests', '.fault-injection-enabled');
}

/**
 * 测试故障注入总闸。
 * 开发树以外恒为 false（fail closed）；开发树内仍需 token + 具体 env + 包根 sentinel。
 */
export function testFaultEnabled(name: string): boolean {
  if (!isDevelopmentRuntime()) return false;
  if (process.env.MFH_TEST_FAULT_TOKEN !== TEST_FAULT_TOKEN) return false;
  if (process.env[name] !== '1') return false;
  try {
    return fs.existsSync(faultSentinelPath());
  } catch {
    return false;
  }
}
