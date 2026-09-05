/**
 * 设置页内部复用的三种字段。放在页面目录里，别的页面用不到。
 */
import { FolderOpenOutlined } from '@ant-design/icons';
import { Button, Form, Input, Space } from 'antd';
import type { FormInstance } from 'antd';
import type { ReactNode } from 'react';
import { bridge } from '../../bridge/index.js';
import type { OpenLocation, SecretPresence } from '../../bridge/index.js';
import { notifyResult } from '../../components/index.js';
import { SECRET_PRESENCE, secretPlaceholder, toNamePath } from './model.js';

export function openLocation(location: OpenLocation): void {
  void bridge.openPath({ location }).then((result) => {
    if (!result.ok) notifyResult(result, { success: '已打开', failure: '打开失败' });
  });
}

export interface TextFieldProps {
  label: string;
  path: string;
  hint?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
}

/** 普通文本字段。 */
export function TextField({ label, path, hint, placeholder, disabled }: TextFieldProps): JSX.Element {
  return (
    <Form.Item label={label} name={toNamePath(path)} extra={hint}>
      <Input placeholder={placeholder} disabled={disabled} autoComplete="off" />
    </Form.Item>
  );
}

export interface PathFieldProps extends TextFieldProps {
  /** 有对应位置时右侧显示「打开」。 */
  location?: OpenLocation;
  /** 传了表单实例才显示「选择…」：选完的路径要写回这个字段。 */
  form?: FormInstance;
  /** 选完之后通知页面重算「有未保存的修改」——程序化写值不会触发 onValuesChange。 */
  onChanged?: () => void;
}

/**
 * 路径字段：可直接编辑，右侧「打开」按位置调用主进程，「选择…」弹系统目录选择框。
 *
 * 选择框回的是原始绝对路径，原样写进表单再原样提交——脱敏只作用于 get-config 的
 * 展示串，这里换成展示串就写不进配置文件了。
 */
export function PathField({
  label,
  path,
  hint,
  placeholder,
  location,
  form,
  onChanged,
  disabled,
}: PathFieldProps): JSX.Element {
  const canPick = Boolean(form) && bridge.supports('pickDirectory');

  function pick(): void {
    void bridge.pickDirectory({ title: `选择${label}目录` }).then((result) => {
      if (result.canceled) return;
      if (!result.ok || !result.path) {
        notifyResult(result, { success: '已选择', failure: '没能选择目录' });
        return;
      }
      form?.setFieldValue(toNamePath(path), result.path);
      onChanged?.();
    });
  }

  return (
    <Form.Item label={label} extra={hint}>
      <Space.Compact style={{ width: '100%' }}>
        <Form.Item name={toNamePath(path)} noStyle>
          <Input placeholder={placeholder} disabled={disabled} autoComplete="off" spellCheck={false} />
        </Form.Item>
        {canPick ? (
          <Button disabled={disabled} onClick={pick}>
            选择…
          </Button>
        ) : null}
        {location ? (
          <Button icon={<FolderOpenOutlined />} disabled={disabled} onClick={() => openLocation(location)}>
            打开
          </Button>
        ) : null}
      </Space.Compact>
    </Form.Item>
  );
}

export interface SecretFieldProps {
  label: string;
  path: string;
  hint?: ReactNode;
  secrets: SecretPresence | undefined;
  cleared: ReadonlySet<string>;
  onClear(path: string): void;
  disabled?: boolean;
}

/**
 * 密钥字段。回读永远是空的：留空表示不修改已保存的值，
 * 想换成「没有值」得显式点「清除」。
 */
export function SecretField({
  label,
  path,
  hint,
  secrets,
  cleared,
  onClear,
  disabled,
}: SecretFieldProps): JSX.Element {
  const presenceKey = SECRET_PRESENCE[path];
  const stored = Boolean(presenceKey && secrets?.[presenceKey]);
  const isCleared = cleared.has(path);
  const clearable = stored && !isCleared;
  // extra 只在真有内容时才给：空节点也会占一行高度。
  const extra =
    hint || clearable ? (
      <Space size={8} wrap>
        {hint ? <span>{hint}</span> : null}
        {clearable ? (
          <Button
            type="link"
            size="small"
            style={{ padding: 0, height: 'auto' }}
            disabled={disabled}
            onClick={() => onClear(path)}
          >
            清除
          </Button>
        ) : null}
      </Space>
    ) : undefined;
  return (
    <Form.Item label={label} name={toNamePath(path)} extra={extra}>
      <Input.Password
        placeholder={secretPlaceholder(path, secrets, isCleared)}
        disabled={disabled}
        autoComplete="new-password"
      />
    </Form.Item>
  );
}
