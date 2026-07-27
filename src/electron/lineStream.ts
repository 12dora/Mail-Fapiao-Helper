import { StringDecoder } from 'node:string_decoder';

/**
 * 子进程输出的按行装配器（APP-23）。
 *
 * 每个 stream 独立持有一个 `StringDecoder`，多字节中文字符被拆到两个 chunk 时
 * 不会解码成乱码；未以换行结束的尾部内容会被 carry 到下一个 chunk，close 时再
 * 由 `flush()` 交出，避免完整的 `OCR complete: ...` 终态行被 chunk 边界切断。
 */
export class LineAssembler {
  private readonly decoder = new StringDecoder('utf8');
  private carry = '';

  /** 写入一个 chunk，返回其中已经完整结束的行（不含换行符）。 */
  push(chunk: Buffer): string[] {
    const text = this.carry + this.decoder.write(chunk);
    const parts = text.split(/\r?\n/);
    this.carry = parts.pop() ?? '';
    return parts;
  }

  /** 流结束时交出剩余的半行（可能为空数组）。 */
  flush(): string[] {
    const tail = this.carry + this.decoder.end();
    this.carry = '';
    return tail.length > 0 ? [tail] : [];
  }
}

/**
 * 有界的诊断输出缓冲：只保留最后 N 行。原实现把子进程全部 chunk 无界保留到
 * 退出为止，长任务会让主进程内存随输出持续增长。
 */
export class LineRingBuffer {
  private readonly lines: string[] = [];
  private dropped = 0;

  constructor(private readonly max = 500) {}

  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.max) {
      this.lines.shift();
      this.dropped++;
    }
  }

  /** 是否有行因为超出上限被丢弃。 */
  get truncated(): boolean {
    return this.dropped > 0;
  }

  toString(): string {
    const body = this.lines.join('\n');
    return this.dropped > 0 ? `…（已省略 ${this.dropped} 行较早输出）\n${body}` : body;
  }
}
