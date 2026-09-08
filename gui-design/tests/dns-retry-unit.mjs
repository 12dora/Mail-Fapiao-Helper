import assert from 'node:assert/strict';
import { lookupAddresses } from '../../dist/util/urlPolicy.js';

// 本机代理让 getaddrinfo 时好时坏：失败要先重试、再直连解析，最后才算 DNS 失败。
function deps(script) {
  const calls = { lookup: 0, direct: 0, sleeps: [] };
  return {
    calls,
    deps: {
      async lookup(host) {
        const step = script.lookup[calls.lookup++] ?? script.lookup.at(-1);
        if (step === 'fail') throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
        return step;
      },
      async resolveDirect() {
        calls.direct++;
        if (script.direct === 'fail') throw new Error('ENODATA');
        return script.direct;
      },
      async sleep(ms) { calls.sleeps.push(ms); },
      withDeadline: (promise) => promise,
    },
  };
}

const ok = [{ address: '1.2.3.4', family: 4 }];
{
  const t = deps({ lookup: ['fail', 'fail', ok], direct: 'fail' });
  assert.deepEqual(await lookupAddresses('flaky.example', t.deps), ok);
  assert.equal(t.calls.lookup, 3);
  assert.deepEqual(t.calls.sleeps, [400, 800]);
  assert.equal(t.calls.direct, 0, 'direct resolver is a fallback, not the first choice');
}
{
  const t = deps({ lookup: ['fail'], direct: ok });
  assert.deepEqual(await lookupAddresses('resolver-only.example', t.deps), ok);
  assert.equal(t.calls.lookup, 3);
  assert.equal(t.calls.direct, 1);
}
{
  const t = deps({ lookup: [[]], direct: 'fail' });
  await assert.rejects(() => lookupAddresses('dead.example', t.deps), { message: 'blocked_url:dns:dead.example' });
  assert.equal(t.calls.direct, 1);
}
{
  const t = deps({ lookup: [ok], direct: 'fail' });
  assert.deepEqual(await lookupAddresses('healthy.example', t.deps), ok);
  assert.equal(t.calls.lookup, 1);
  assert.deepEqual(t.calls.sleeps, []);
}
{
  // 卡住的解析按超时失败，不会无限等。
  const calls = { direct: 0 };
  const hanging = {
    lookup: () => new Promise(() => {}),
    resolveDirect: async () => { calls.direct++; return ok; },
    sleep: async () => {},
    withDeadline: (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`dns_timeout:${ms}`)), 5))]),
  };
  assert.deepEqual(await lookupAddresses('hanging.example', hanging), ok);
  assert.equal(calls.direct, 1);
}
console.log('dns-retry-unit: passed');
