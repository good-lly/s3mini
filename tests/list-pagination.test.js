'use strict';

/**
 * Unit tests only — mock fetch to pin the paths that only open up past S3's 1000-key ceiling:
 * an unlimited listObjects() following the server's own truncation, and deleteObjects splitting
 * into whole batches. Neither is reachable from a smaller bucket, and driving them against a live
 * provider cost 1 114 uploads + 1 114 deletes per run (see the pagination test in _shared.test.js,
 * which now only checks that a real bucket honours maxKeys and a continuation token).
 */

import { S3mini } from '../src/S3.ts';

const baseConfig = {
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  endpoint: 'https://my-bucket.s3.us-east-1.amazonaws.com',
  region: 'us-east-1',
};

const xmlResponse = body => new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });

const keysFrom = (start, count) => Array.from({ length: count }, (_, i) => `object${start + i}.txt`);

const listPage = (keys, nextToken) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bucket</Name>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>${nextToken ? 'true' : 'false'}</IsTruncated>
  ${nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : ''}
  ${keys
    .map(
      k =>
        `<Contents><Key>${k}</Key><LastModified>2026-06-16T22:14:34.000Z</LastModified><Size>1</Size>` +
        `<ETag>"e"</ETag><StorageClass>STANDARD</StorageClass></Contents>`,
    )
    .join('')}
</ListBucketResult>`;

describe('listing past the 1000-key server cap', () => {
  it('follows continuation tokens until the server stops truncating', async () => {
    const pages = [
      { keys: keysFrom(0, 1000), token: 'T1' },
      { keys: keysFrom(1000, 1000), token: 'T2' },
      { keys: keysFrom(2000, 114), token: undefined },
    ];
    const requests = [];
    const s3 = new S3mini({
      ...baseConfig,
      fetch: async input => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        requests.push({
          maxKeys: url.searchParams.get('max-keys'),
          token: url.searchParams.get('continuation-token'),
        });
        const page = pages[requests.length - 1];
        return xmlResponse(listPage(page.keys, page.token));
      },
    });

    const objects = await s3.listObjects();

    expect(objects).toHaveLength(2114);
    expect(objects[0].Key).toBe('object0.txt');
    expect(objects.at(-1).Key).toBe('object2113.txt');
    // A caller that asked for everything gets everything: each request stays under the S3 ceiling
    // and resumes from the token the previous page handed back. Dropping either silently cuts the
    // result off at 1000 — which reads as an empty bucket tail rather than as an error.
    expect(requests.map(r => r.maxKeys)).toEqual(['1000', '1000', '1000']);
    expect(requests.map(r => r.token)).toEqual([null, 'T1', 'T2']);
  });

  it('splits a bulk delete larger than 1000 targets into whole batches', async () => {
    const batches = [];
    const s3 = new S3mini({
      ...baseConfig,
      fetch: async (input, init) => {
        const sent = [...String(init.body).matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]);
        batches.push(sent);
        return xmlResponse(
          `<?xml version="1.0" encoding="UTF-8"?><DeleteResult>${sent
            .map(k => `<Deleted><Key>${k}</Key></Deleted>`)
            .join('')}</DeleteResult>`,
        );
      },
    });

    const keys = keysFrom(0, 1114);
    const results = await s3.deleteObjects(keys);

    // Over-sized batches are rejected by the API, so every target has to land in exactly one
    // request and every request has to report back — a dropped batch would otherwise surface as
    // objects that quietly stayed in the bucket.
    expect(batches.map(b => b.length).sort((a, b) => b - a)).toEqual([1000, 114]);
    expect(batches.flat().sort()).toEqual(keys.slice().sort());
    expect(results).toHaveLength(1114);
    expect(results.every(r => r === true)).toBe(true);
  });
});
