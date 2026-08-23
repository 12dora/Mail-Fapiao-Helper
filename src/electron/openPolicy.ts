import fs from 'node:fs';
import path from 'node:path';
import { sanitizeText } from './sanitize.js';

export interface OpenPolicyDependencies {
  e2eNoGuiMode(): boolean;
  shell: {
    openPath(target: string): Promise<string>;
    showItemInFolder(target: string): void;
  };
}
/**
 * B2 / ELEC-06：桌面「真正打开」的唯一出口。
 * 只能由 openOrRevealByPolicy 在 disposition 已判定为 open 后调用；
 * 接收不透明策略令牌，调用方无法用原始路径字符串绕过。
 * `shell.openPath` 在本文件中只应出现于此一处。
 */
const OPEN_PATH_POLICY_TOKEN: unique symbol = Symbol('OPEN_PATH_POLICY_APPROVED');
interface PolicyApprovedOpenPath {
  readonly [OPEN_PATH_POLICY_TOKEN]: true;
  readonly path: string;
}

export function createOpenPolicy(deps: OpenPolicyDependencies) {
  const { e2eNoGuiMode, shell } = deps;

function mintPolicyApprovedOpenPath(target: string): PolicyApprovedOpenPath {
  return { [OPEN_PATH_POLICY_TOKEN]: true as const, path: target };
}

async function shellOpenPathApproved(approved: PolicyApprovedOpenPath): Promise<string> {
  if (!approved || approved[OPEN_PATH_POLICY_TOKEN] !== true || typeof approved.path !== 'string') {
    return '打开路径未通过安全策略校验。';
  }
  if (e2eNoGuiMode()) return '';
  return shell.openPath(approved.path);
}

function showItemInFolderForUser(target: string): void {
  if (e2eNoGuiMode()) return;
  shell.showItemInFolder(target);
}

/**
 * S2 / B2：open-path 对「文件目标」的打开策略——不仅校验 where 与扩展名，
 * 还在铸造 open 令牌前用内容 magic 正向确认文档类型。
 *
 * 应用合法产出（pdf/ofd/csv/xml/图片/zip/eml/log）且内容匹配才 shell.openPath；
 * 可执行 / 快捷方式扩展名一律拒绝；macOS 替身（含经典 resource-fork `alis`）/
 * Windows 快捷方式等间接文件即使伪装成 .eml/.pdf 也不得 open；其余文件改为
 * 请求在文件夹中显示（不断言文件管理器一定弹出）。
 *
 * 文件 open 可达面：仅主进程签发的 `ext:` 句柄（落在主控归档根内），或主进程
 * 内部已 containment 的归档路径（如 pending 邮件）。renderer 用配置派生 path
 * 打开时只 reveal——缩小 pathname TOCTOU 攻击面。
 *
 * 目录：bundle-like（.app 等）一律拒绝；普通目录仅当 allowDirectoryOpen（符号
 * location 或主进程签发的 ext: 句柄）才 shell.openPath。任意 renderer 提供的
 * 目录 path 最多 reveal，绝不 open——避免 macOS 把 .app 当目录启动。
 *
 * 不存在的目标一律 refuse（path_missing），不得 reveal/open 后报成功。
 */
const OPENABLE_DOCUMENT_EXTS = new Set([
  '.pdf', '.ofd', '.csv', '.xml',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff',
  '.zip',
  // 应用产出的邮件缓存与诊断日志
  '.eml', '.log',
]);

const REFUSED_EXECUTABLE_EXTS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.ps1', '.msi',
  '.app', '.command', '.sh',
  // 额外常见可执行 / 脚本载体
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msc', '.jar',
  '.dll', '.so', '.dylib', '.pkg', '.dmg', '.appimage',
  // 快捷方式 / 链接载体（含 x.pdf.lnk 等双扩展伪装）
  '.lnk', '.url', '.desktop', '.webloc',
]);

/** macOS/系统 bundle 目录后缀：对 shell.openPath 等于「启动应用」。 */
const BUNDLE_DIRECTORY_SUFFIXES = [
  '.app',
  '.bundle',
  '.framework',
  '.plugin',
  '.kext',
  '.workflow',
  '.scptd',
  '.prefPane',
  '.service',
] as const;

/** 打开前内容嗅探：只读文件头部，避免整文件进内存。 */
const OPEN_CONTENT_SNIFF_BYTES = 4096;

/**
 * 规范化用于扩展名策略的 basename：去尾部点/空白（Windows 与部分 API 会忽略它们，
 * 攻击者可用 `evil.app.` / `x.pdf ` 绕过简单 extname 检查）。
 */
function stripTrailingDotsAndSpaces(name: string): string {
  let s = name;
  while (s.length > 0) {
    const c = s.charCodeAt(s.length - 1);
    // space, tab, CR, LF, or '.'
    if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a || c === 0x2e) {
      s = s.slice(0, -1);
      continue;
    }
    break;
  }
  return s;
}

function policyBaseName(target: string): string {
  return stripTrailingDotsAndSpaces(path.basename(target));
}

function policyExtname(target: string): string {
  const base = policyBaseName(target);
  if (!base) return '';
  return path.extname(base).toLowerCase();
}

function isBundleLikeDirectoryName(baseName: string): boolean {
  const lower = stripTrailingDotsAndSpaces(baseName).toLowerCase();
  if (!lower) return false;
  return BUNDLE_DIRECTORY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** 读取文件头部字节；失败返回 undefined（调用方不得 open）。 */
function readFileHeadForOpenPolicy(target: string, maxBytes = OPEN_CONTENT_SNIFF_BYTES): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, 'r');
    const buf = Buffer.alloc(Math.max(1, maxBytes));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

/**
 * 现代 macOS Finder 替身 / bookmark 数据头：`book\0\0\0\0mark\0\0\0\0`。
 * realpath 不会解析它，但 NSWorkspace.openURL 会像 Finder 一样跟随。
 */
function isMacBookmarkAliasHead(data: Buffer): boolean {
  return data.length >= 16
    && data.subarray(0, 4).toString('latin1') === 'book'
    && data[4] === 0 && data[5] === 0 && data[6] === 0 && data[7] === 0
    && data.subarray(8, 12).toString('latin1') === 'mark'
    && data[12] === 0 && data[13] === 0 && data[14] === 0 && data[15] === 0;
}

/** Windows Shell Link（.lnk）头：`4C 00 00 00 01 14 02 00`。 */
function isWindowsShellLinkHead(data: Buffer): boolean {
  return data.length >= 8
    && data[0] === 0x4c && data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x00
    && data[4] === 0x01 && data[5] === 0x14 && data[6] === 0x02 && data[7] === 0x00;
}

/**
 * INI 风格指针文件（.url / .desktop）以及常见 webloc/plist URL 指针。
 * 名称可伪装成 .pdf/.eml，内容却只是跳转。
 */
function isIniStylePointerHead(data: Buffer): boolean {
  const start = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
  const text = data.subarray(start, Math.min(data.length, 512)).toString('utf8').trimStart();
  const lower = text.toLowerCase();
  if (lower.startsWith('[internetshortcut]')) return true;
  if (lower.startsWith('[desktop entry]')) {
    // .desktop 可能是应用启动器；一律视为间接文件，不得 open。
    return true;
  }
  // binary plist webloc
  if (data.length >= 8 && data.subarray(0, 8).toString('latin1') === 'bplist00') return true;
  // XML plist webloc / Internet Location
  if (lower.startsWith('<?xml') || lower.startsWith('<plist')) {
    if (lower.includes('webloc') || lower.includes('internet location') || /<key>\s*url\s*<\/key>/i.test(text)) {
      return true;
    }
  }
  return false;
}

/** 去掉 BOM 后的头部切片起点。 */
function headSkipBom(data: Buffer): number {
  return data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
}

function headHasNul(data: Buffer, from: number, maxLen: number): boolean {
  const end = Math.min(data.length, from + maxLen);
  for (let i = from; i < end; i++) {
    if (data[i] === 0) return true;
  }
  return false;
}

function headPrintableRatio(data: Buffer, from: number, maxLen: number): number {
  const end = Math.min(data.length, from + maxLen);
  if (end <= from) return 0;
  let ok = 0;
  for (let i = from; i < end; i++) {
    const c = data[i] ?? 0;
    if (c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c !== 0x7f)) ok++;
  }
  return ok / (end - from);
}

function looksLikeXmlDocumentHead(data: Buffer): boolean {
  let i = headSkipBom(data);
  while (i < data.length && (data[i] === 0x20 || data[i] === 0x09 || data[i] === 0x0a || data[i] === 0x0d)) i++;
  const head = data.subarray(i, Math.min(data.length, i + 256)).toString('utf8');
  if (head.startsWith('<?xml')) return true;
  // 允许无声明的根元素；拒绝明显二进制。
  return /^<[A-Za-z_!?]/.test(head) && !headHasNul(data, i, 256);
}

function looksLikeEmlDocumentHead(data: Buffer): boolean {
  const start = headSkipBom(data);
  if (headHasNul(data, start, 512)) return false;
  if (headPrintableRatio(data, start, 1024) < 0.9) return false;
  const text = data.subarray(start, Math.min(data.length, start + 2048)).toString('utf8');
  // mbox 分隔行
  if (/^From \S+/m.test(text.slice(0, 200))) return true;
  // RFC 5322 风格邮件头（应用写出的 .eml 均具备）
  return /^(?:Return-Path|Received|From|To|Cc|Bcc|Subject|Date|Message-ID|Message-Id|MIME-Version|Content-Type|Content-Transfer-Encoding|Delivered-To|Reply-To|X-[\w-]+)\s*:/im.test(text);
}

function looksLikeCsvDocumentHead(data: Buffer): boolean {
  const start = headSkipBom(data);
  if (data.length <= start) return false;
  if (headHasNul(data, start, 1024)) return false;
  if (headPrintableRatio(data, start, 2048) < 0.95) return false;
  const text = data.subarray(start, Math.min(data.length, start + 2048)).toString('utf8');
  // 台账 / INDEX 等产出至少含分隔符
  return /[,;\t]/.test(text);
}

function looksLikeLogDocumentHead(data: Buffer): boolean {
  const start = headSkipBom(data);
  if (data.length <= start) return false;
  if (headHasNul(data, start, 1024)) return false;
  return headPrintableRatio(data, start, 2048) >= 0.95;
}

/**
 * 内容是否正向匹配「扩展名声称的」可打开文档类型。
 * 与 extract/sites 侧 detectDocumentKind 一致：只认字节，不认文件名。
 * 替身 / 快捷方式 / 未知二进制一律 false → 上层 reveal，永不 mint open 令牌。
 */
function contentMatchesClaimedOpenableType(ext: string, data: Buffer): boolean {
  // 间接文件：名字像文档，内容是指针——不得 open。
  if (isMacBookmarkAliasHead(data) || isWindowsShellLinkHead(data) || isIniStylePointerHead(data)) {
    return false;
  }
  switch (ext) {
    case '.pdf':
      // 与 sites/common.detectDocumentKind 一致：允许前 1KB 内出现 %PDF。
      return data.subarray(0, Math.min(data.length, 1024)).includes('%PDF');
    case '.ofd':
    case '.zip':
      // OFD 是 PK 容器；打开策略只要求 archive magic（不解包验证 OFD.xml）。
      return data.length >= 2 && data[0] === 0x50 && data[1] === 0x4b;
    case '.png':
      return data.length >= 8 && data.subarray(0, 4).toString('latin1') === '\x89PNG';
    case '.jpg':
    case '.jpeg':
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case '.gif':
      return data.length >= 4 && data.subarray(0, 4).toString('latin1') === 'GIF8';
    case '.bmp':
      return data.length >= 2 && data.subarray(0, 2).toString('latin1') === 'BM';
    case '.webp':
      return data.length >= 12
        && data.subarray(0, 4).toString('latin1') === 'RIFF'
        && data.subarray(8, 12).toString('latin1') === 'WEBP';
    case '.tif':
    case '.tiff':
      return data.length >= 4
        && ((data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a && data[3] === 0x00)
          || (data[0] === 0x4d && data[1] === 0x4d && data[2] === 0x00 && data[3] === 0x2a));
    case '.xml':
      return looksLikeXmlDocumentHead(data);
    case '.csv':
      return looksLikeCsvDocumentHead(data);
    case '.eml':
      return looksLikeEmlDocumentHead(data);
    case '.log':
      return looksLikeLogDocumentHead(data);
    default:
      return false;
  }
}

/**
 * 在 buffer 中查找 4 字节 ASCII fourcc（如 resource type `alis`）。
 * 不跨字节对齐假设——resource map 中 type code 按 4 字节对齐，
 * 全缓冲扫描足够廉价且对错位 map 仍 fail-closed 友好。
 */
function bufferHasAsciiFourcc(data: Buffer, fourcc: string): boolean {
  if (fourcc.length !== 4 || data.length < 4) return false;
  const a = fourcc.charCodeAt(0);
  const b = fourcc.charCodeAt(1);
  const c = fourcc.charCodeAt(2);
  const d = fourcc.charCodeAt(3);
  for (let i = 0; i <= data.length - 4; i++) {
    if (data[i] === a && data[i + 1] === b && data[i + 2] === c && data[i + 3] === d) return true;
  }
  return false;
}

/**
 * macOS Finder 替身探测结果：
 * - `alias`：已确认（bookmark 头或 resource fork 中的 `alis`）→ 拒绝 open
 * - `clean`：未发现替身迹象
 * - `unknown`：无法判定（读失败等）→ 不得 open，上层改为 reveal
 *
 * 现代替身：数据叉 bookmark magic `book\0\0\0\0mark\0\0\0\0`。
 * 经典替身：数据叉可为合法 RFC5322/.pdf 等，别名在 resource fork 的 `alis` 资源里；
 * Node 经伪路径 `<file>/..namedfork/rsrc` 读取；无 resource fork 时 size 0 或 ENOENT。
 */
function probeMacFinderAlias(target: string, head: Buffer): 'alias' | 'clean' | 'unknown' {
  if (isMacBookmarkAliasHead(head)) return 'alias';
  if (process.platform !== 'darwin') return 'clean';
  if (!target || target.includes('\0')) return 'unknown';
  try {
    // 必须用字面伪路径；path.join 在部分平台上会错误规范化 `..namedfork`。
    const rsrcPath = `${target}/..namedfork/rsrc`;
    let st: fs.Stats;
    try {
      st = fs.statSync(rsrcPath);
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err
        ? String((err as NodeJS.ErrnoException).code)
        : '';
      // 无 resource fork：普通文件。
      if (code === 'ENOENT') return 'clean';
      // 权限/IO 等：无法判定 → fail closed（不 open）。
      return 'unknown';
    }
    if (!st.isFile()) return 'unknown';
    if (st.size <= 0) return 'clean';
    // 经典 alias 的 resource map 通常很小；上限内扫描 `alis` type code。
    // 超大 fork 读不全且未找到 alis 时按 unknown 处理（不 open）。
    const maxScan = 256 * 1024;
    const rsrc = readFileHeadForOpenPolicy(rsrcPath, Math.min(st.size, maxScan));
    if (!rsrc) return 'unknown';
    if (bufferHasAsciiFourcc(rsrc, 'alis')) return 'alias';
    if (st.size > maxScan) return 'unknown';
    return 'clean';
  } catch {
    return 'unknown';
  }
}

/**
 * 廉价检测 macOS Finder 替身（防御纵深）。
 * 真正检查 `target`：数据叉 bookmark 头 +（darwin）resource fork 中的 `alis`。
 * 无法判定时视为可疑（true），调用方不得 mint open 令牌。
 */
function hasMacFinderAliasIndicator(target: string, head: Buffer): boolean {
  const probe = probeMacFinderAlias(target, head);
  return probe === 'alias' || probe === 'unknown';
}

type OpenFileDisposition =
  | { action: 'open' }
  | { action: 'reveal' }
  | { action: 'refuse'; code: string; message: string };

type OpenPolicyOpts = {
  /**
   * 仅符号 location / 主进程 ext: 句柄为 true；
   * 任意 path 载荷必须为 false，目录最多 reveal。
   */
  allowDirectoryOpen?: boolean;
  /**
   * 文件 open 仅允许：主进程签发的 `ext:` 句柄所指向的、落在主控归档根内的目标。
   * 渲染进程用配置派生 path 打开时必须为 false → 只 reveal，永不 shell.openPath。
   * 主进程内部（如 pending 邮件路径）在已 containment 校验后可显式开启。
   */
  allowFileOpen?: boolean;
};

/**
 * @param opts.allowDirectoryOpen 仅符号 location / 主进程 ext: 句柄为 true。
 * @param opts.allowFileOpen 仅 ext: 句柄或主进程已校验归档路径为 true；其余文件只 reveal。
 */
function dispositionForOpenTarget(
  target: string,
  opts: OpenPolicyOpts = {},
): OpenFileDisposition {
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch {
    // 目标不存在：不得 open/reveal 后报成功（false-success 类缺陷）。
    // 对缺失的 .app / .exe 仍给出明确拒绝文案，其余统一 path_missing。
    const missingExt = policyExtname(target);
    const missingBase = policyBaseName(target);
    if (missingBase && isBundleLikeDirectoryName(missingBase)) {
      return {
        action: 'refuse',
        code: 'path_bundle_refused',
        message: '出于安全考虑，不能打开应用程序包或系统插件包。',
      };
    }
    if (missingExt && REFUSED_EXECUTABLE_EXTS.has(missingExt)) {
      return {
        action: 'refuse',
        code: 'path_executable_refused',
        message: '出于安全考虑，不能打开可执行文件或脚本。请在文件管理器中自行处理。',
      };
    }
    return {
      action: 'refuse',
      code: 'path_missing',
      message: '目标位置不存在，无法打开或在文件夹中显示。请确认路径是否正确，或先在应用内完成抓取/归档。',
    };
  }
  if (st.isDirectory()) {
    const base = policyBaseName(target);
    if (isBundleLikeDirectoryName(base)) {
      return {
        action: 'refuse',
        code: 'path_bundle_refused',
        message: '出于安全考虑，不能打开应用程序包或系统插件包。',
      };
    }
    // 普通目录：只允许 location / 主进程句柄路径 open；任意 path 只 reveal。
    if (opts.allowDirectoryOpen === true) return { action: 'open' };
    return { action: 'reveal' };
  }
  if (!st.isFile()) {
    return {
      action: 'refuse',
      code: 'path_not_openable',
      message: '该目标不是可打开的文件或文件夹。',
    };
  }
  const ext = policyExtname(target);
  if (ext && REFUSED_EXECUTABLE_EXTS.has(ext)) {
    return {
      action: 'refuse',
      code: 'path_executable_refused',
      message: '出于安全考虑，不能打开可执行文件或脚本。请在文件管理器中自行处理。',
    };
  }
  // 真正 ALLOW-LIST：白名单扩展名 + 内容 magic 正向匹配才 open。
  if (ext && OPENABLE_DOCUMENT_EXTS.has(ext)) {
    const head = readFileHeadForOpenPolicy(target);
    if (!head) {
      // 读不到内容：不 mint open 令牌，最多 reveal（若仍存在）。
      return { action: 'reveal' };
    }
    // macOS 替身：bookmark 头或经典 resource-fork `alis`。
    // 确认 alias → refuse；无法判定 → reveal（不 open，也不谎称已打开）。
    const aliasProbe = probeMacFinderAlias(target, head);
    if (aliasProbe === 'alias') {
      return {
        action: 'refuse',
        code: 'path_alias_refused',
        message: '出于安全考虑，不能打开 macOS 替身（别名）文件。请打开真实的文档原件。',
      };
    }
    if (aliasProbe === 'unknown') {
      return { action: 'reveal' };
    }
    if (isWindowsShellLinkHead(head) || isIniStylePointerHead(head)) {
      return {
        action: 'refuse',
        code: 'path_shortcut_refused',
        message: '出于安全考虑，不能打开快捷方式或链接文件。请打开真实的文档原件。',
      };
    }
    if (!contentMatchesClaimedOpenableType(ext, head)) {
      // 扩展名声称是文档，内容却不是 → 只 reveal，永不 open。
      return { action: 'reveal' };
    }
    // 文件 open 仅限主控归档路径上的主进程句柄（或主进程内部已校验路径）。
    if (opts.allowFileOpen !== true) return { action: 'reveal' };
    return { action: 'open' };
  }
  return { action: 'reveal' };
}

/**
 * reveal 成功文案：shell.showItemInFolder 返回 void，我们只能确认「已发出请求」
 * 且目标当时仍存在，不能断言文件管理器窗口一定出现。对用户说清楚实际做了什么。
 */
const REVEAL_REQUESTED_FILE_MSG =
  '已请求在文件管理器中显示该文件。若未看到窗口，请到应用内对应文件夹查找。';
const REVEAL_REQUESTED_LOCATION_MSG =
  '已请求在文件管理器中显示该位置。若未看到窗口，请通过应用内的文件夹入口再试。';
const REVEAL_REQUESTED_BUNDLE_MSG =
  '已请求在文件管理器中显示该应用程序包（不会启动）。若未看到窗口，请手动在访达中查看。';
const REVEAL_REQUESTED_UNSUITABLE_MSG =
  '该文件不适合直接打开；已请求在文件管理器中显示。若未看到窗口，请到应用内对应文件夹查找。';

type OpenPolicyResult = {
  ok: boolean;
  error: string;
  code?: string;
  message?: string;
  revealed?: boolean;
};

function missingResult(message: string): OpenPolicyResult {
  return {
    ok: false,
    error: '目标不存在。',
    code: 'path_missing',
    message,
  };
}

function refusedResult(code: string, message: string): OpenPolicyResult {
  return {
    ok: false,
    error: message,
    code,
    message,
  };
}

function revealedResult(code: string, message: string): OpenPolicyResult {
  return {
    ok: true,
    error: '',
    revealed: true,
    code,
    message,
  };
}

function revealTarget(
  target: string,
  missingMessage: string,
  revealedMessage: string,
  code = 'path_revealed',
  checkBeforeReveal = true,
): OpenPolicyResult {
  if (checkBeforeReveal && !fs.existsSync(target)) {
    return missingResult(missingMessage);
  }
  showItemInFolderForUser(target);
  if (!fs.existsSync(target)) {
    return missingResult('目标在显示前已消失，未能发出在文件夹中显示的请求。');
  }
  return revealedResult(code, revealedMessage);
}

function forceReveal(target: string): OpenPolicyResult {
  if (!fs.existsSync(target)) {
    return missingResult('目标位置不存在，无法在文件夹中显示。');
  }
  // forceReveal 仍拒绝把 bundle 当「打开」；只请求在文件夹中显示（不 launch）。
  const base = policyBaseName(target);
  try {
    const st = fs.statSync(target);
    if (st.isDirectory() && isBundleLikeDirectoryName(base)) {
      // reveal 父目录中的 bundle 项是安全的（不会启动 .app）
      return revealTarget(
        target,
        '目标位置不存在，无法在文件夹中显示。',
        REVEAL_REQUESTED_BUNDLE_MSG,
        'path_bundle_revealed',
        false,
      );
    }
  } catch {
    if (!fs.existsSync(target)) {
      return missingResult('目标位置不存在，无法在文件夹中显示。');
    }
  }
  return revealTarget(
    target,
    '目标位置不存在，无法在文件夹中显示。',
    REVEAL_REQUESTED_FILE_MSG,
    'path_revealed',
    false,
  );
}

async function openApprovedTarget(target: string): Promise<OpenPolicyResult> {
  // Residual pathname TOCTOU: content check closes its fd before shell.openPath, which
  // only accepts a path string (Electron has no fd-based open). An attacker who can
  // atomically replace the file between recheck and Launch Services' resolution could
  // still win. Mitigations above shrink the window and require main-issued ext: handles
  // (or main-internal archive paths) — never renderer-supplied config paths — for file
  // open. Residual risk: the attacker must already have write access *inside* the user's
  // own archive directory; anyone with that access can already replace invoice files
  // directly, so the marginal gain from winning this race is small. Not fully fixed.
  const error = await shellOpenPathApproved(mintPolicyApprovedOpenPath(target));
  if (error) {
    return {
      ok: false,
      error: sanitizeText(error, { maxLength: 200 }),
      code: 'path_open_failed',
      message: '无法打开该文件，请确认它仍然存在且有对应的应用程序。',
    };
  }
  return { ok: true, error: '' };
}

async function recheckOpenTarget(
  target: string,
  policyOpts: OpenPolicyOpts,
): Promise<OpenPolicyResult> {
  // 唯一 shell.openPath 调用路径：仅在策略判定 action=open（含内容校验）后铸造令牌再打开。
  // 打开前再确认仍是文件，并在 mint 前立刻重跑内容/替身检查，尽量缩短 TOCTOU 窗口。
  try {
    const st = fs.statSync(target);
    if (!st.isFile() && !(st.isDirectory() && policyOpts.allowDirectoryOpen === true)) {
      return {
        ok: false,
        error: '目标已不再是可打开的文件。',
        code: 'path_not_openable',
        message: '目标已不再是可打开的文件或文件夹。',
      };
    }
  } catch {
    return missingResult('目标位置不存在，无法打开。请确认它仍然存在。');
  }
  // mint 前最后一次策略重检（含读头 + resource fork 替身探测）。
  const recheck = dispositionForOpenTarget(target, policyOpts);
  if (recheck.action === 'refuse') {
    return refusedResult(recheck.code, recheck.message);
  }
  if (recheck.action !== 'open') {
    return revealTarget(
      target,
      '目标位置不存在，无法在文件夹中显示。',
      REVEAL_REQUESTED_UNSUITABLE_MSG,
    );
  }
  return openApprovedTarget(target);
}

/**
 * 按文件类型策略打开目标：允许则 open，否则 reveal 或拒绝。
 * 返回给 IPC 的统一形状。不存在的目标永远 ok:false。
 */
async function openOrRevealByPolicy(
  target: string,
  opts: OpenPolicyOpts & { forceReveal?: boolean } = {},
): Promise<OpenPolicyResult> {
  const policyOpts: OpenPolicyOpts = {
    allowDirectoryOpen: opts.allowDirectoryOpen === true,
    allowFileOpen: opts.allowFileOpen === true,
  };
  if (opts.forceReveal) {
    return forceReveal(target);
  }
  const disposition = dispositionForOpenTarget(target, policyOpts);
  if (disposition.action === 'refuse') {
    return refusedResult(disposition.code, disposition.message);
  }
  if (disposition.action === 'reveal') {
    // reveal 前再次确认存在：策略判定与调用之间可能消失；不存在不得报成功。
    return revealTarget(
      target,
      '目标位置不存在，无法在文件夹中显示。请确认路径是否正确，或先在应用内完成抓取/归档。',
      policyOpts.allowFileOpen || policyOpts.allowDirectoryOpen
        ? REVEAL_REQUESTED_UNSUITABLE_MSG
        : REVEAL_REQUESTED_LOCATION_MSG,
    );
  }
  return recheckOpenTarget(target, policyOpts);
}

  return { openOrRevealByPolicy, showItemInFolderForUser };
}
