/**
 * 保存标签页：文件存放位置、重命名规则、按类型整理。
 */
import { Card, Form, Input, Space, Switch } from 'antd';
import type { FormInstance } from 'antd';
import { PathField } from './fields.js';
import { toNamePath } from './model.js';

export interface StorageTabProps {
  form: FormInstance;
  disabled: boolean;
}

export function StorageTab({ form, disabled }: StorageTabProps): JSX.Element {
  const applyAfterOcr = Form.useWatch(toNamePath('rename.applyAfterOcr'), form) as boolean | undefined;
  const organizeByType = Form.useWatch(toNamePath('rename.organizeByType'), form) as boolean | undefined;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="位置">
        <PathField
          label="发票"
          path="paths.invoices"
          location="invoices"
          placeholder="./invoices"
          hint="发票与行程单原件存放在这里。"
          disabled={disabled}
        />
        <PathField
          label="邮件"
          path="paths.samples"
          location="samples"
          placeholder="./samples/raw"
          hint="保留邮件原文，便于重新处理。"
          disabled={disabled}
        />
        <PathField
          label="待确认"
          path="paths.pending"
          location="pending"
          placeholder="./pending"
          hint="需要人工处理的邮件放在这里。"
          disabled={disabled}
        />
        <PathField
          label="清单"
          path="output.csv"
          location="ledger"
          placeholder="./invoices.csv"
          hint="汇总已归档发票的表格，可用 Excel 打开。"
          disabled={disabled}
        />
      </Card>

      <Card size="small" title="命名">
        <Form.Item
          label="避免重名"
          name={toNamePath('rename.avoidConflictBeforeOcr')}
          valuePropName="checked"
          extra="同名文件自动加序号，不会互相覆盖。"
        >
          <Switch disabled={disabled} />
        </Form.Item>

        <Form.Item
          label="重命名"
          name={toNamePath('rename.applyAfterOcr')}
          valuePropName="checked"
          extra="识别成功后按下面的规则改名。"
        >
          <Switch disabled={disabled} />
        </Form.Item>

        <Form.Item
          label="命名规则"
          name={toNamePath('rename.rule')}
          extra="可用 {date} {seller} {amount} {invoiceNo}。"
        >
          <Input placeholder="{seller}-{amount}.pdf" disabled={disabled || !applyAfterOcr} autoComplete="off" />
        </Form.Item>

        <Form.Item label="备用规则" name={toNamePath('rename.fallback')} extra="识别不出信息时改用这条。">
          <Input placeholder="{date}-{messageId}.pdf" disabled={disabled || !applyAfterOcr} autoComplete="off" />
        </Form.Item>
      </Card>

      <Card size="small" title="整理">
        <Form.Item
          label="分类归档"
          name={toNamePath('rename.organizeByType')}
          valuePropName="checked"
          extra="按票据类型复制一份到整理目录。"
        >
          <Switch disabled={disabled} />
        </Form.Item>

        <Form.Item label="目录规则" name={toNamePath('rename.typeDirRule')} extra="可用 {documentType} {date}。">
          <Input placeholder="{documentType}" disabled={disabled || !organizeByType} autoComplete="off" />
        </Form.Item>

        <PathField
          label="整理目录"
          path="rename.organizedDir"
          location="organized"
          placeholder="./invoices/organized"
          hint="分类归档的副本存放在这里。"
          disabled={disabled || !organizeByType}
        />
      </Card>
    </Space>
  );
}
