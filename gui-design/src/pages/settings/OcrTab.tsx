/**
 * 识别标签页：识别开关、云端密钥、以及折叠起来的服务参数。
 */
import { Card, Collapse, Form, Input, InputNumber, Select, Space, Switch } from 'antd';
import type { FormInstance } from 'antd';
import type { SecretPresence } from '../../bridge/index.js';
import { SecretField } from './fields.js';
import { toNamePath } from './model.js';

export interface OcrTabProps {
  form: FormInstance;
  secrets: SecretPresence | undefined;
  cleared: ReadonlySet<string>;
  onClear(path: string): void;
  disabled: boolean;
}

const MODE_OPTIONS = [
  { value: 'auto', label: '先用本机规则，必要时用云端' },
  { value: 'disabled', label: '只用本机规则' },
  { value: 'required', label: '每份文件都用云端' },
];

const EXEC_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'serve', label: '常驻服务' },
  { value: 'cli', label: '逐份调用' },
];

const VENDOR_OPTIONS = [
  { value: '', label: '自动选择' },
  { value: 'none', label: '不用云端' },
  { value: 'cnocr', label: '本机模型' },
  { value: 'http', label: '自建服务' },
  { value: 'tencent', label: '腾讯云' },
];

export function OcrTab({ form, secrets, cleared, onClear, disabled }: OcrTabProps): JSX.Element {
  const enabled = Form.useWatch(toNamePath('ocr.enabled'), form) as boolean | undefined;
  const vendor = (Form.useWatch(toNamePath('ocr.credentials.ocrVendor'), form) as string | undefined) ?? '';
  const off = disabled || enabled === false;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="识别">
        <Form.Item label="启用" name={toNamePath('ocr.enabled')} valuePropName="checked" extra="关闭后只保存原件，不读取票面信息。">
          <Switch disabled={disabled} />
        </Form.Item>

        <Form.Item label="引擎" name={toNamePath('ocr.provider')} extra="目前只有内置引擎。">
          <Select options={[{ value: 'efapiao', label: '内置识别引擎' }]} disabled style={{ maxWidth: 320 }} />
        </Form.Item>

        <Form.Item label="识别方式" name={toNamePath('ocr.ocrMode')} extra="用到云端时会上传发票与行程单文件。">
          <Select options={MODE_OPTIONS} disabled={off} style={{ maxWidth: 320 }} />
        </Form.Item>

        <Space size={16} wrap>
          <Form.Item label="每批数量" name={toNamePath('ocr.batchSize')} extra="每批识别的文件数量。">
            <InputNumber min={1} max={200} precision={0} style={{ width: 160 }} disabled={off} />
          </Form.Item>
          <Form.Item label="超时" name={toNamePath('ocr.timeoutMs')} extra="单份文件的等待上限。">
            <InputNumber min={1} precision={0} addonAfter="秒" style={{ width: 160 }} disabled={off} />
          </Form.Item>
        </Space>
      </Card>

      <Card size="small" title="密钥">
        <Form.Item label="密钥来源" name={toNamePath('ocr.credentials.ocrVendor')} extra="留「自动选择」时按已填的密钥判断。">
          <Select options={VENDOR_OPTIONS} disabled={off} style={{ maxWidth: 320 }} />
        </Form.Item>

        {vendor === 'tencent' ? (
          <>
            <SecretField
              label="云端 ID"
              path="ocr.credentials.tencentSecretId"
              secrets={secrets}
              cleared={cleared}
              onClear={onClear}
              disabled={off}
            />
            <SecretField
              label="云端密钥"
              path="ocr.credentials.tencentSecretKey"
              secrets={secrets}
              cleared={cleared}
              onClear={onClear}
              disabled={off}
            />
            <Form.Item label="服务区域" name={toNamePath('ocr.credentials.tencentRegion')} extra="按控制台里显示的区域填写。">
              <Input placeholder="ap-shanghai" disabled={off} autoComplete="off" />
            </Form.Item>
          </>
        ) : null}

        {vendor === 'http' ? (
          <SecretField
            label="接口密钥"
            path="ocr.credentials.apiKey"
            hint="调用自建识别服务时附带。"
            secrets={secrets}
            cleared={cleared}
            onClear={onClear}
            disabled={off}
          />
        ) : null}

        {vendor === 'cnocr' ? (
          <Form.Item label="模型档位" name={toNamePath('ocr.credentials.cnocrModelProfile')} extra="不确定时保持默认。">
            <Input placeholder="invoice-lite" disabled={off} autoComplete="off" />
          </Form.Item>
        ) : null}

        {vendor === '' || vendor === 'none' ? (
          <div style={{ color: 'var(--mfh-text-dim)' }}>选择来源后在这里填写对应密钥。</div>
        ) : null}
      </Card>

      <Collapse
        size="small"
        items={[
          {
            key: 'advanced',
            label: '服务参数',
            children: (
              <>
                <Form.Item label="运行方式" name={toNamePath('ocr.executionMode')} extra="不确定时保持自动。">
                  <Select options={EXEC_OPTIONS} disabled={off} style={{ maxWidth: 320 }} />
                </Form.Item>

                <Form.Item label="服务地址" name={toNamePath('ocr.serviceUrl')} extra="留空表示由本机启动识别服务。">
                  <Input placeholder="https://ocr.example.com" disabled={off} autoComplete="off" />
                </Form.Item>

                <Space size={16} wrap>
                  <Form.Item label="监听地址" name={toNamePath('ocr.serviceHost')} extra="仅支持本机地址。">
                    <Input placeholder="127.0.0.1" style={{ width: 180 }} disabled={off} autoComplete="off" />
                  </Form.Item>
                  <Form.Item label="端口" name={toNamePath('ocr.servicePort')} extra="被占用时改一个。">
                    <InputNumber min={1} max={65535} precision={0} style={{ width: 140 }} disabled={off} />
                  </Form.Item>
                </Space>

                <Space size={16} wrap>
                  <Form.Item label="并发" name={toNamePath('ocr.serviceWorkers')} extra="同时工作的进程数。">
                    <InputNumber min={1} max={16} precision={0} style={{ width: 140 }} disabled={off} />
                  </Form.Item>
                  <Form.Item label="启动等待" name={toNamePath('ocr.serviceStartupMs')} extra="等服务就绪的上限。">
                    <InputNumber min={1} precision={0} addonAfter="秒" style={{ width: 160 }} disabled={off} />
                  </Form.Item>
                </Space>
              </>
            ),
          },
        ]}
      />
    </Space>
  );
}
