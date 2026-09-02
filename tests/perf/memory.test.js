'use strict';
// Empirical leak measurement. Scenario 1 is the original 404-loadtest repro; scenarios 2-3 measure
// the two undrained-body review findings (createBucket tolerated-status path, getObjectWithETag
// missing-ETag throw); scenario 4 is the drained control. Each scenario gets its own local stub
// server so per-scenario TCP connection counts are clean. Two instruments:
//   - heapUsed after forced GC → unbounded leak or not
//   - server-side connection count / max concurrently open → whether an unread body blocks
//     keep-alive reuse (GC-bounded socket + buffer retention)
// Needs --expose-gc; run via `npm run test:memory`.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { S3mini } from '../../dist/index.mjs';

if (typeof global.gc !== 'function') {
  console.error('global.gc missing — run via `npm run test:memory` (needs --expose-gc).');
  process.exit(1);
}

const HEAP_LIMIT = 3 * 1024 * 1024;
const mb = b => (b / 1024 / 1024).toFixed(2);

const XML_404 =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><Key>missing.bin</Key></Error>';
const XML_409 =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Error><Code>BucketAlreadyOwnedByYou</Code><Message>Your previous request to create the named bucket succeeded.</Message></Error>';
// Larger than undici's fetch response-stream highWaterMark, so an unread body must exercise
// backpressure instead of being swallowed into the stream queue.
const BIG = Buffer.alloc(256 * 1024, 0x61);

const xml = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/xml' });
  res.end(body);
};

const settleHeap = async () => {
  global.gc();
  await new Promise(r => setTimeout(r, 150)); // let FinalizationRegistry cancels + socket closes run
  global.gc();
  await new Promise(r => setTimeout(r, 50));
  return process.memoryUsage().heapUsed;
};

const runScenario = async ({ name, iterations, handler, op }) => {
  const sockets = new Set();
  let connections = 0;
  let maxOpen = 0;
  const server = createServer(handler);
  server.on('connection', s => {
    connections++;
    sockets.add(s);
    maxOpen = Math.max(maxOpen, sockets.size);
    s.on('close', () => sockets.delete(s));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const s3 = new S3mini({
    accessKeyId: 'test',
    secretAccessKey: 'test',
    endpoint: `http://127.0.0.1:${server.address().port}/test-bucket`,
    region: 'us-east-1',
  });

  for (let i = 0; i < Math.min(50, iterations); i++) await op(s3);
  const base = await settleHeap();
  connections = 0;
  maxOpen = sockets.size;

  for (let i = 0; i < iterations; i++) await op(s3);
  const beforeGc = process.memoryUsage().heapUsed;
  const settled = await settleHeap();

  server.close();
  for (const s of sockets) s.destroy();

  const growth = settled - base;
  const leak = growth > HEAP_LIMIT;
  if (leak) process.exitCode = 1;
  console.log(`\n${name} (${iterations}×)`);
  console.log(`  heap after GC: ${mb(base)} → ${mb(settled)} MB (Δ ${mb(growth)} MB) ${leak ? '❌ LEAK' : '✅ flat'}`);
  console.log(`  heap before final GC: ${mb(beforeGc)} MB (transient, reclaimed by GC)`);
  console.log(`  TCP connections: ${connections} for ${iterations} requests, max open at once: ${maxOpen}`);
  return { name, iterations, growth, connections, maxOpen };
};

const s404 = await runScenario({
  name: '1. getObjectRaw → 404 (error path drains body)',
  iterations: 10_000,
  handler: (req, res) => xml(res, 404, XML_404),
  op: s3 =>
    s3.getObjectRaw('missing.bin').then(
      () => {
        throw new Error('expected 404 throw');
      },
      e => {
        if (e?.status !== 404) throw e;
      },
    ),
});

const sCreate = await runScenario({
  name: '2. createBucket → 409 tolerated, small XML body never drained (finding 1)',
  iterations: 10_000,
  handler: (req, res) => xml(res, 409, XML_409),
  op: s3 => s3.createBucket(),
});

const sEtag = await runScenario({
  name: '3. getObjectWithETag → 200, no ETag header, 256KB body never drained (finding 2)',
  iterations: 100,
  handler: (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(BIG);
  },
  op: s3 =>
    s3.getObjectWithETag('big.bin').then(
      () => {
        throw new Error('expected missing-ETag throw');
      },
      e => {
        if (!/ETag not found/.test(String(e))) throw e;
      },
    ),
});

const sControl = await runScenario({
  name: '4. control: getObjectArrayBuffer → 200 with ETag, 256KB body drained',
  iterations: 100,
  handler: (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', etag: '"abc123"' });
    res.end(BIG);
  },
  op: s3 => s3.getObjectArrayBuffer('big.bin'),
});

console.log('\n──────── verdicts ────────');
const anyLeak = [s404, sCreate, sEtag, sControl].some(s => s.growth > HEAP_LIMIT);
console.log(
  anyLeak
    ? '❌ unbounded heap leak detected — see scenarios above'
    : '✅ no unbounded heap leak in any scenario (heap returns to baseline after GC)',
);
console.log(
  sCreate.connections <= s404.connections * 2 + 5
    ? `ℹ️  finding 1 (createBucket): small undrained body does NOT block connection reuse ` +
        `(${sCreate.connections} connections vs ${s404.connections} on the draining path) — impact limited to tiny buffers held until GC`
    : `⚠️  finding 1 (createBucket): undrained body blocks connection reuse (${sCreate.connections} connections for ${sCreate.iterations} requests)`,
);
console.log(
  sEtag.connections >= sEtag.iterations * 0.9
    ? `⚠️  finding 2 (getObjectWithETag): undrained large body blocks reuse — ${sEtag.connections} connections for ${sEtag.iterations} requests, ` +
        `${sEtag.maxOpen} sockets open at once (control: ${sControl.connections} connections, max ${sControl.maxOpen} open)`
    : `ℹ️  finding 2 (getObjectWithETag): no connection-reuse impact measured ` +
        `(${sEtag.connections} connections vs control ${sControl.connections})`,
);
