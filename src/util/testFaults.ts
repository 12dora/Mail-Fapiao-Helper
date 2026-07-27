import fs from 'node:fs';
import path from 'node:path';

const TEST_FAULT_TOKEN = 'mail-fapiao-helper-test-faults';
const TEST_FAULT_SENTINEL = path.join('gui-design', 'tests', '.fault-injection-enabled');

export function testFaultEnabled(name: string): boolean {
  if (process.env.MFH_TEST_FAULT_TOKEN !== TEST_FAULT_TOKEN) return false;
  if (process.env[name] !== '1') return false;
  return fs.existsSync(path.resolve(process.cwd(), TEST_FAULT_SENTINEL));
}
