/**
 * 设置页：邮箱 / 保存 / 识别 / 关于。
 *
 * 四个标签页共用一个 antd Form 实例，所以在标签间来回切换不会丢掉没保存的修改，
 * 底部那条「保存 / 放弃更改」也就能对整份配置负责。
 *
 * 保存时只提交**改过的字段**：主进程回给渲染层的配置是脱敏过的（密钥清空、
 * 绝对路径换成展示串），整份回写会把展示串当成真路径写回去。
 */
import { Alert, Button, Form, Skeleton, Space, Tabs } from 'antd';
import { PageHeader, useBusy } from '../../components/index.js';
import { navigate, useRoute } from '../../router.js';
import { AboutTab } from './AboutTab.js';
import { MailTab } from './MailTab.js';
import { OcrTab } from './OcrTab.js';
import { StorageTab } from './StorageTab.js';
import { asTabKey, type TabKey } from './model.js';
import { useSettingsForm, type SettingsFormState } from './useSettingsForm.js';

const TAB_LABELS: Record<TabKey, string> = { mail: '邮箱', storage: '保存', ocr: '识别', about: '关于' };

function tabItems(state: SettingsFormState): { key: string; label: string; children: JSX.Element }[] {
  const { form, payload, cleared, onClear, locked, onValuesChange } = state;
  return [
    {
      key: 'mail',
      label: TAB_LABELS.mail,
      children: (
        <MailTab form={form} secrets={payload?.secrets} cleared={cleared} onClear={onClear} disabled={locked} />
      ),
    },
    {
      key: 'storage',
      label: TAB_LABELS.storage,
      children: <StorageTab form={form} disabled={locked} onChanged={onValuesChange} />,
    },
    {
      key: 'ocr',
      label: TAB_LABELS.ocr,
      children: (
        <OcrTab form={form} secrets={payload?.secrets} cleared={cleared} onClear={onClear} disabled={locked} />
      ),
    },
    {
      key: 'about',
      label: TAB_LABELS.about,
      children: <AboutTab configPath={payload?.configPath ?? ''} dataDir={payload?.dataDir ?? ''} />,
    },
  ];
}

/** 页面底部固定的一条操作栏；只有真有改动时才可用。 */
function ActionBar({ state }: { state: SettingsFormState }): JSX.Element {
  const { busy } = useBusy();
  const { dirty, saving, save, discard } = state;
  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 16px',
        borderTop: '1px solid var(--mfh-border)',
        background: 'var(--mfh-surface)',
      }}
    >
      <span style={{ color: 'var(--mfh-text-dim)' }}>{dirty ? '有未保存的修改' : ''}</span>
      <Space style={{ marginInlineStart: 'auto' }}>
        <Button disabled={!dirty || saving} onClick={discard}>
          放弃更改
        </Button>
        <Button
          type="primary"
          data-testid="action-settings-save"
          loading={saving}
          disabled={!dirty || busy}
          onClick={() => void save()}
        >
          保存
        </Button>
      </Space>
    </div>
  );
}

export function SettingsPage(): JSX.Element {
  const route = useRoute();
  const tab = asTabKey(route.sub);
  const state = useSettingsForm();
  const { form, payload, baseline, configError, loadError, repairing, repair, onValuesChange } = state;

  return (
    <>
      <PageHeader title="设置" subtitle={payload?.configPath || '正在读取本机配置'} />

      <div className="mfh-scroll">
        {loadError ? <Alert type="error" showIcon message="读取配置失败" description={loadError} /> : null}

        {configError ? (
          <Alert
            type="error"
            showIcon
            data-testid="config-error"
            message="配置文件无法读取"
            description={configError}
            action={
              <Button danger loading={repairing} onClick={repair}>
                修复配置
              </Button>
            }
          />
        ) : null}

        <div style={{ width: '100%', maxWidth: 640 }}>
          {/* 配置到手前不渲染表单：initialValues 只在首次挂载生效，早挂载会锁死默认值。 */}
          {!payload ? (
            <Skeleton active paragraph={{ rows: 8 }} />
          ) : (
            <Form
              form={form}
              layout="vertical"
              requiredMark={false}
              initialValues={baseline}
              onValuesChange={onValuesChange}
            >
              <Tabs activeKey={tab} items={tabItems(state)} onChange={(key) => navigate('settings', key)} />
            </Form>
          )}
        </div>
      </div>

      {tab === 'about' ? null : <ActionBar state={state} />}
    </>
  );
}
