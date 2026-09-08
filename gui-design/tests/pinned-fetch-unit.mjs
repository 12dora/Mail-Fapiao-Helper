import assert from 'node:assert/strict';
import http from 'node:http';
import { safeServiceFetch } from '../../dist/util/net.js';

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve({
      contentType: String(req.headers['content-type'] ?? ''),
      contentLength: req.headers['content-length'],
      body: Buffer.concat(chunks),
    }));
    req.on('error', reject);
  });
}

async function withLocalServer(run) {
  const waiters = [];
  const server = http.createServer((req, res) => {
    const waiter = waiters.shift();
    if (!waiter) {
      res.writeHead(500).end('no waiter');
      return;
    }
    readRequest(req).then((captured) => {
      waiter.resolve(captured);
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    }, (err) => {
      waiter.reject(err);
      res.writeHead(500).end('read failed');
    });
  });
  const next = () => new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const origin = `http://127.0.0.1:${addr.port}`;
  try {
    await run({ origin, next });
  } finally {
    while (waiters.length > 0) {
      waiters.shift().reject(new Error('server closed'));
    }
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

await withLocalServer(async ({ origin, next }) => {
  const formSeen = next();
  const form = new FormData();
  form.set('file', new Blob([Buffer.from('%PDF-1.4 mock')]), 'invoice.pdf');
  form.set('hint_type', 'pdf');
  form.set('ocr_mode', 'auto');
  const formRes = await safeServiceFetch(`${origin}/form`, { method: 'POST', body: form });
  assert.equal(formRes.status, 200);
  const formReq = await formSeen;
  const multipartPrefix = 'multipart/form-data; boundary=';
  assert.equal(formReq.contentType.startsWith(multipartPrefix), true);
  const boundary = formReq.contentType.slice(multipartPrefix.length);
  assert.ok(boundary.length > 0);
  const formText = formReq.body.toString('latin1');
  assert.equal(formText.includes(boundary), true);
  assert.equal(formText.includes('name="file"'), true);
  assert.equal(formText.includes('filename="invoice.pdf"'), true);
  assert.equal(formText.includes('name="hint_type"'), true);
  assert.equal(formText.includes('name="ocr_mode"'), true);
  assert.equal(Number(formReq.contentLength), formReq.body.length);

  const paramsSeen = next();
  const params = new URLSearchParams();
  params.set('hint_type', 'pdf');
  params.set('ocr_mode', 'auto');
  const paramsRes = await safeServiceFetch(`${origin}/urlencoded`, { method: 'POST', body: params });
  assert.equal(paramsRes.status, 200);
  const paramsReq = await paramsSeen;
  assert.equal(paramsReq.contentType, 'application/x-www-form-urlencoded;charset=UTF-8');
  assert.equal(paramsReq.body.toString(), 'hint_type=pdf&ocr_mode=auto');
  assert.equal(Number(paramsReq.contentLength), paramsReq.body.length);

  const overrideSeen = next();
  const overrideRes = await safeServiceFetch(`${origin}/override`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: new URLSearchParams({ keep: '1' }),
  });
  assert.equal(overrideRes.status, 200);
  const overrideReq = await overrideSeen;
  assert.equal(overrideReq.contentType, 'text/plain; charset=utf-8');
});

console.log('pinned-fetch-unit: passed');
