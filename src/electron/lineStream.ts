import { StringDecoder } from 'node:string_decoder';

/**
 * 子进程输出的按行装配器（APP-23 / ELEC-11）。
 *
 * 每个 stream 独立持有一个 `StringDecoder`，多字节中文字符被拆到两个 chunk 时
 * 不会解码成乱码；未以换行结束的尾部内容会被 carry 到下一个 chunk，close 时再
 * 由 `flush()` 交出，避免完整的 `OCR complete: ...` 终态行被 chunk 边界切断。
 *
 * carry 有硬上限：超长未换行输出进入丢弃模式，直到下一个换行，避免绕过
 * ring buffer 的行数上限把主进程内存撑爆。
 */

/** 单行 / carry 上限（字符）。超过后截断并丢弃至下一行。 */
const DEFAULT_MAX_LINE_CHARS = 64 * 1024;

export class LineAssembler {
  private readonly decoder = new StringDecoder('utf8');
  private carry = '';
  /** 已超过上限，正在丢弃直到下一个换行。 */
  private discarding = false;
  private readonly maxLineChars: number;

  constructor(maxLineChars = DEFAULT_MAX_LINE_CHARS) {
    this.maxLineChars = maxLineChars;
  }

  /** 写入一个 chunk，返回其中已经完整结束的行（不含换行符）。 */
  push(chunk: Buffer): string[] {
    const incoming = this.decoder.write(chunk);
    return this.consume(incoming);
  }

  /** 流结束时交出剩余的半行（可能为空数组）。 */
  flush(): string[] {
    const tail = this.decoder.end();
    const lines = this.consume(tail);
    if (this.discarding) {
      this.carry = '';
      this.discarding = false;
      return lines;
    }
    if (this.carry.length > 0) {
      const last = this.finalizeCarry();
      this.carry = '';
      if (last !== undefined) lines.push(last);
    }
    return lines;
  }

  private consume(incoming: string): string[] {
    const out: string[] = [];
    let text = incoming;
    while (text.length > 0) {
      if (this.discarding) {
        const nl = text.search(/\r?\n/);
        if (nl < 0) return out;
        // 丢弃到换行（含换行），恢复正常装配。
        text = text.slice(nl).replace(/^\r?\n/, '');
        this.discarding = false;
        this.carry = '';
        continue;
      }

      const combined = this.carry + text;
      const parts = combined.split(/\r?\n/);
      this.carry = parts.pop() ?? '';
      for (const part of parts) {
        out.push(part.length > this.maxLineChars
          ? `${part.slice(0, this.maxLineChars)}…（行过长已截断）`
          : part);
      }

      if (this.carry.length > this.maxLineChars) {
        out.push(`${this.carry.slice(0, this.maxLineChars)}…（行过长已截断）`);
        this.carry = '';
        this.discarding = true;
        // 当前 combined 已处理完；若 text 里没有更多内容，等待后续 chunk。
        text = '';
      } else {
        text = '';
      }
    }
    return out;
  }

  private finalizeCarry(): string | undefined {
    if (this.carry.length === 0) return undefined;
    if (this.carry.length > this.maxLineChars) {
      return `${this.carry.slice(0, this.maxLineChars)}…（行过长已截断）`;
    }
    return this.carry;
  }
}

/**
 * 有界的诊断输出缓冲：只保留最后 N 行。原实现把子进程全部 chunk 无界保留到
 * 退出为止，长任务会让主进程内存随输出持续增长。
 */
export class LineRingBuffer {
  private readonly lines: string[] = [];
  private dropped = 0;
  private totalChars = 0;
  private readonly maxChars: number;

  constructor(
    private readonly max = 500,
    maxChars = 512 * 1024,
  ) {
    this.maxChars = maxChars;
  }

  push(line: string): void {
    this.lines.push(line);
    this.totalChars += line.length;
    while (
      this.lines.length > this.max
      || (this.totalChars > this.maxChars && this.lines.length > 1)
    ) {
      const removed = this.lines.shift();
      if (removed !== undefined) this.totalChars -= removed.length;
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
