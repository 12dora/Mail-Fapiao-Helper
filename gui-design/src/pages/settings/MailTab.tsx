/**
 * 邮箱标签页：连接参数 + 邮件筛选。
 */
import { Button, Card, Checkbox, Col, Form, Input, InputNumber, Row, Select, Space, Switch } from 'antd';
import type { FormInstance } from 'antd';
import { useState } from 'react';
import { bridge } from '../../bridge/index.js';
import type { ConfigDraft, SecretPresence } from '../../bridge/index.js';
import { notify, notifyResult } from '../../components/index.js';
import { SecretField } from './fields.js';
import { toNamePath } from './model.js';

export interface MailTabProps {
  form: FormInstance;
  secrets: SecretPresence | undefined;
  cleared: ReadonlySet<string>;
  onClear(path: string): void;
  disabled: boolean;
}

interface ImapValues {
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  tls?: boolean;
  mailbox?: string[];
}

/** 用当前表单里的连接参数试一次；密钥留空时主进程会回退到已保存的值。 */
function imapDraft(form: FormInstance): ConfigDraft {
  const imap = (form.getFieldValue('imap') ?? {}) as ImapValues;
  const payload: Record<string, unknown> = {
    host: imap.host ?? '',
    port: imap.port ?? 993,
    user: imap.user ?? '',
    tls: imap.tls !== false,
    mailbox: imap.mailbox ?? [],
  };
  if (imap.pass) payload.pass = imap.pass;
  return { imap: payload };
}

export function MailTab({ form, secrets, cleared, onClear, disabled }: MailTabProps): JSX.Element {
  const [testing, setTesting] = useState(false);
  const [loadingBoxes, setLoadingBoxes] = useState(false);
  const [mailboxes, setMailboxes] = useState<string[]>([]);

  const selected = (Form.useWatch(['imap', 'mailbox'], form) as string[] | undefined) ?? [];
  const options = Array.from(new Set([...mailboxes, ...selected])).map((name) => ({ label: name, value: name }));

  async function test(): Promise<void> {
    setTesting(true);
    try {
      const result = await bridge.testMailConnection(imapDraft(form));
      notifyResult(result, { success: '邮箱连接正常', failure: '邮箱连接失败' });
    } finally {
      setTesting(false);
    }
  }

  async function loadMailboxes(): Promise<void> {
    setLoadingBoxes(true);
    try {
      const result = await bridge.listMailboxes(imapDraft(form));
      if (!result.ok) {
        notifyResult(result, { success: '已读取', failure: '读取文件夹失败' });
        return;
      }
      setMailboxes(result.mailboxes ?? []);
      notify.success(`读到 ${result.mailboxes?.length ?? 0} 个文件夹`);
    } finally {
      setLoadingBoxes(false);
    }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="连接">
        <Row gutter={12}>
          <Col span={16}>
            <Form.Item label="服务器" name={toNamePath('imap.host')} extra="在邮箱网页版的「收信设置」里可以查到。">
              <Input placeholder="imap.exmail.qq.com" disabled={disabled} autoComplete="off" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="端口" name={toNamePath('imap.port')} extra="加密连接通常是 993。">
              <InputNumber min={1} max={65535} precision={0} style={{ width: '100%' }} disabled={disabled} />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item label="账号" name={toNamePath('imap.user')} extra="填完整邮箱地址。">
          <Input placeholder="you@example.com" disabled={disabled} autoComplete="off" />
        </Form.Item>

        <SecretField
          label="授权码"
          path="imap.pass"
          hint="只保存在本机。"
          secrets={secrets}
          cleared={cleared}
          onClear={onClear}
          disabled={disabled}
        />

        <Form.Item label="加密连接" name={toNamePath('imap.tls')} valuePropName="checked" extra="除非邮箱要求，保持开启。">
          <Switch disabled={disabled} />
        </Form.Item>

        <Form.Item label="文件夹" extra="不选表示扫描全部文件夹。">
          <Space.Compact style={{ width: '100%' }}>
            <Form.Item name={toNamePath('imap.mailbox')} noStyle>
              <Select
                mode="multiple"
                allowClear
                placeholder="全部文件夹"
                options={options}
                disabled={disabled}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Button onClick={() => void loadMailboxes()} loading={loadingBoxes} disabled={disabled}>
              读取
            </Button>
          </Space.Compact>
        </Form.Item>

        <Button onClick={() => void test()} loading={testing} disabled={disabled}>
          测试连接
        </Button>
      </Card>

      <Card size="small" title="筛选">
        <Form.Item label="关键词" name={toNamePath('filter.keywords')} extra="回车添加，命中任意一个即视为发票邮件。">
          <Select mode="tags" open={false} placeholder="发票、行程单、invoice" disabled={disabled} suffixIcon={null} />
        </Form.Item>

        <Form.Item label="匹配范围" extra="两项至少选一项。">
          <Space size={20}>
            <Form.Item name={toNamePath('filter.matchSubject')} valuePropName="checked" noStyle>
              <Checkbox disabled={disabled}>标题</Checkbox>
            </Form.Item>
            <Form.Item name={toNamePath('filter.matchBody')} valuePropName="checked" noStyle>
              <Checkbox disabled={disabled}>正文</Checkbox>
            </Form.Item>
          </Space>
        </Form.Item>

        <Form.Item label="回溯天数" name={toNamePath('filter.sinceDays')} extra="不指定日期时默认往回找这么多天。">
          <InputNumber min={1} precision={0} addonAfter="天" style={{ width: 200 }} disabled={disabled} />
        </Form.Item>
      </Card>
    </Space>
  );
}
