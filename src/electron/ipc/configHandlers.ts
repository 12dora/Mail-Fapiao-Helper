import fs from 'node:fs';
import { asObject } from '../payload.js';
import { redactPath, sanitizeText } from '../sanitize.js';
import type { OperationHandlerDependencies } from './operationHandlers.js';

export function registerConfigHandlers(deps: Pick<OperationHandlerDependencies,
  'handleTrusted' | 'loadGuiConfig' | 'configPath' | 'bundledConfigPath' | 'redactConfig' | 'dataDir' | 'coordinator' | 'saveConfig'
>): void {
  const { handleTrusted, loadGuiConfig, configPath, bundledConfigPath, redactConfig, dataDir, coordinator, saveConfig } = deps;
  handleTrusted('mfh:get-config', () => {
    const { cfg, error } = loadGuiConfig(configPath, bundledConfigPath);
    const typedCfg = cfg as Record<string, unknown> & { imap?: { pass?: string } };
    // Redact secrets so they never reach the renderer process. We still report whether each
    // secret is populated so the UI can show "已保存（留空则不修改）" placeholders.
    const ocrSrc = (typedCfg as { ocr?: Record<string, unknown> }).ocr ?? {};
    const credsSrc = asObject((ocrSrc as Record<string, unknown>).credentials);
    const redactedConfig = redactConfig(typedCfg as unknown as Record<string, unknown>);
    const secrets = {
      imapPass: Boolean(typedCfg.imap?.pass),
      tencentSecretId: Boolean(credsSrc.tencentSecretId || credsSrc.secretId),
      tencentSecretKey: Boolean(credsSrc.tencentSecretKey || credsSrc.secretKey),
      ocrApiKey: Boolean(credsSrc.apiKey),
    };
    return {
      // ELEC-07：绝对路径不进 renderer；仅提供脱敏展示串。
      configPath: redactPath(configPath),
      configExists: fs.existsSync(configPath),
      // 保留原字段名（renderer 已在读取），同时新增结构化版本。
      configError: error ? sanitizeText(error) : '',
      configErrorInfo: error ? { message: sanitizeText(error) } : undefined,
      config: redactedConfig,
      secrets,
      dataDir: redactPath(dataDir),
    };
  });

  handleTrusted('mfh:save-config', (_event, payload: unknown) => {
    // ELEC-02：配置写入与 CLI 任务互斥，避免运行中改写 paths/ocr 造成交错。
    const begin = coordinator.begin('pipeline', { silent: true });
    if (!begin.ok) {
      return {
        ok: false,
        configPath: redactPath(configPath),
        configError: { message: begin.message },
      };
    }
    try {
      const raw = asObject(payload);
      return saveConfig(payload, { repairCorrupt: raw.repairCorrupt === true });
    } finally {
      begin.lease.release();
    }
  });

}
