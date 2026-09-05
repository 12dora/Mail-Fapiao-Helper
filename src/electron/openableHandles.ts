import { randomBytes } from 'node:crypto';

interface OpenableHandleDependencies {
  resolveCanonicalPath: (inputPath: string) => string | undefined;
  isInsideOpenPathAllowedRoots: (candidate: string) => boolean;
}

/** 主进程签发的外部文件 opaque 句柄（renderer 不可伪造路径）。 */
const externalFileHandles = new Map<string, string>();
const handlesByPath = new Map<string, string>();

export function createOpenableHandles(deps: OpenableHandleDependencies) {
  function registerExternalFileHandle(canonicalPath: string): string {
    // 签发时也必须在当前允许根内，否则拒绝铸造
    if (!deps.isInsideOpenPathAllowedRoots(canonicalPath)) return '';
    const existing = handlesByPath.get(canonicalPath);
    if (existing) {
      // 刷新顺序，避免本次响应刚复用的旧句柄被后续签发驱逐。
      externalFileHandles.delete(existing);
      externalFileHandles.set(existing, canonicalPath);
      return existing;
    }
    const id = `ext:${randomBytes(12).toString('hex')}`;
    externalFileHandles.set(id, canonicalPath);
    handlesByPath.set(canonicalPath, id);
    // 覆盖单次最多 100000 行的响应，同时保持注册表有界。
    if (externalFileHandles.size > 200000) {
      const keys = externalFileHandles.keys();
      for (let i = 0; i < 50000; i++) {
        const oldest = keys.next().value!;
        handlesByPath.delete(externalFileHandles.get(oldest)!);
        externalFileHandles.delete(oldest);
      }
    }
    return id;
  }

  function resolveExternalFileHandle(id: string): string | undefined {
    if (typeof id !== 'string' || !id.startsWith('ext:')) return undefined;
    const registered = externalFileHandles.get(id);
    if (!registered) return undefined;
    const canon = deps.resolveCanonicalPath(registered);
    if (!canon) return undefined;
    // 赎回时按当前允许根重验；配置改掉后旧句柄失效
    if (!deps.isInsideOpenPathAllowedRoots(canon)) {
      externalFileHandles.delete(id);
      handlesByPath.delete(registered);
      return undefined;
    }
    return canon;
  }

  return { registerExternalFileHandle, resolveExternalFileHandle };
}
