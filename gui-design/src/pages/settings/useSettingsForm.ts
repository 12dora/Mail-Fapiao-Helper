/**
 * 设置页的表单状态：基线、差集、保存 / 放弃 / 修复。
 *
 * 拆成 hook 是为了让页面组件只负责排版；这里不产生任何 JSX。
 */
import { App as AntApp, Form } from 'antd';
import type { FormInstance } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { bridge, useConfig } from '../../bridge/index.js';
import type { ConfigDraft, ConfigFieldError, ConfigPayload } from '../../bridge/index.js';
import { notify, notifyResult, useBusy } from '../../components/index.js';
import { navigate } from '../../router.js';
import {
  buildDraft,
  errorText,
  SECRET_PATHS,
  tabOfPath,
  toFormValues,
  toNamePath,
  type SettingsValues,
} from './model.js';

export interface SettingsFormState {
  form: FormInstance;
  payload: ConfigPayload | null;
  /** 磁盘上那份配置摊平后的表单值。 */
  baseline: SettingsValues;
  dirty: boolean;
  saving: boolean;
  repairing: boolean;
  /** 配置文件读不出来时的原因；非空表示表单要锁住。 */
  configError: string;
  /** 读取配置本身失败（IPC 层面）。 */
  loadError: string;
  /** 表单是否只读：配置损坏、有长任务在跑、或正在保存。 */
  locked: boolean;
  cleared: ReadonlySet<string>;
  onClear(path: string): void;
  onValuesChange(): void;
  save(): Promise<void>;
  discard(): void;
  repair(): void;
}

export function useSettingsForm(): SettingsFormState {
  const { data: payload, error, reload } = useConfig();
  const { busy } = useBusy();
  const { modal } = AntApp.useApp();
  const [form] = Form.useForm();

  // 表单当前值的副本。antd 的 store 是可变对象，直接在渲染里读它可能拿到挂载前的
  // 空 store，dirty 会永远停在 true——所以每次变更都往 state 里存一份。
  const [values, setValues] = useState<SettingsValues | null>(null);
  const [cleared, setCleared] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [saving, setSaving] = useState(false);
  const [repairing, setRepairing] = useState(false);

  const baseline = useMemo<SettingsValues>(() => toFormValues(payload?.config), [payload]);
  const configError = errorText(payload?.configError);

  const draft = useMemo<ConfigDraft>(
    () => (values ? buildDraft(values, baseline, cleared) : {}),
    [values, baseline, cleared],
  );
  const dirty = Object.keys(draft).length > 0;

  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const errorPathsRef = useRef<string[]>([]);
  const appliedRef = useRef<unknown>(null);
  const forceResetRef = useRef(false);

  function applyBaseline(next: SettingsValues): void {
    form.resetFields();
    form.setFieldsValue(next);
    errorPathsRef.current = [];
    setCleared(new Set<string>());
    setValues({ ...next });
  }

  // 配置被别处刷新（保存后重新读取，或别的页面触发）时，把没动过的表单同步过来。
  useEffect(() => {
    if (!payload) return;
    if (appliedRef.current === payload) return;
    appliedRef.current = payload;
    if (values === null || forceResetRef.current || !dirtyRef.current) {
      forceResetRef.current = false;
      applyBaseline(toFormValues(payload.config));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  function clearFieldErrors(): void {
    if (errorPathsRef.current.length === 0) return;
    form.setFields(errorPathsRef.current.map((path) => ({ name: toNamePath(path), errors: [] })));
    errorPathsRef.current = [];
  }

  function showFieldErrors(errors: ConfigFieldError[]): void {
    form.setFields(errors.map((item) => ({ name: toNamePath(item.path), errors: [item.message] })));
    errorPathsRef.current = errors.map((item) => item.path);
    const first = errors[0];
    if (!first) return;
    navigate('settings', tabOfPath(first.path));
    notify.error('设置未保存', first.message);
  }

  async function save(): Promise<void> {
    if (!dirty) return;
    clearFieldErrors();
    setSaving(true);
    try {
      const result = await bridge.saveConfig(draft);
      if (result.fieldErrors?.length) {
        showFieldErrors(result.fieldErrors);
        return;
      }
      if (!result.ok) {
        const detail = errorText(result.configError) || result.detail || result.error;
        notify.error(result.message?.trim() || '设置未保存', detail || undefined);
        return;
      }
      notifyResult(result, { success: '设置已保存', failure: '设置未保存' });
      // 输入过的密钥不留在表单里：回读永远是空的，留着会一直显示成未保存的修改。
      form.setFields(SECRET_PATHS.map((path) => ({ name: toNamePath(path), value: '' })));
      forceResetRef.current = true;
      await reload();
    } finally {
      setSaving(false);
    }
  }

  function repair(): void {
    modal.confirm({
      title: '修复配置文件',
      content: '当前配置文件会另存为备份，然后按默认值重建。邮箱账号等内容需要重新填写。',
      okText: '修复',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setRepairing(true);
        try {
          const result = await bridge.saveConfig({ repairCorrupt: true });
          notifyResult(result, { success: '配置已修复', failure: '修复失败' });
          if (result.ok) {
            forceResetRef.current = true;
            await reload();
          }
        } finally {
          setRepairing(false);
        }
      },
    });
  }

  return {
    form,
    payload,
    baseline,
    dirty,
    saving,
    repairing,
    configError,
    loadError: error,
    locked: Boolean(configError) || busy || saving,
    cleared,
    onClear: (path) => setCleared((prev) => new Set(prev).add(path)),
    onValuesChange: () => setValues({ ...(form.getFieldsValue(true) as SettingsValues) }),
    save,
    discard: () => {
      clearFieldErrors();
      applyBaseline(baseline);
    },
    repair,
  };
}
