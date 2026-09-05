import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { EFAPIAO_VENDOR_VERSIONS } from './efapiao-vendor.mjs';

test('packaging paths agree with the release audit versions', () => {
  const { build } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const [platform, arch] of [['mac', 'darwin-arm64'], ['win', 'windows-x86_64']]) {
    const directory = `vendor/efapiao/${EFAPIAO_VENDOR_VERSIONS[platform]}/${arch}`;
    assert.deepEqual(build[platform].extraResources, [{ from: directory, to: directory }]);
    if (platform === 'mac') assert.deepEqual(build.mac.binaries, [`Contents/Resources/${directory}/efapiao`]);
  }
});
