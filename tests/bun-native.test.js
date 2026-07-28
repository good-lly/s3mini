'use strict';
import { S3mini } from '../dist/index.mjs';

import * as dotenv from 'dotenv';
dotenv.config();

const raw = process.env.BUCKET_ENV_MINIO ? process.env.BUCKET_ENV_MINIO.split(',') : null;
const nativeBun = typeof globalThis.Bun?.S3Client === 'function';

/**
 * Proves the Bun.S3Client path is actually taken (it silently was not for months: the runtime
 * check compared navigator.userAgent to 'Bun', but Bun reports 'Bun/<version>') and that it
 * answers exactly like the signed-request path it replaces.
 */
if (!nativeBun || !raw) {
  describe.skip('bun native', () => {
    it('skipped', () => {
      expect(true).toBe(true);
    });
  });
} else {
  const [, accessKeyId, secretAccessKey, endpoint, region] = raw;
  // Own bucket: minio.test.js wipes its bucket in beforeAll and these files run in parallel.
  const ownBucket = new URL(endpoint);
  ownBucket.pathname = '/s3mini-bun-native';
  const cfg = { accessKeyId, secretAccessKey, endpoint: ownBucket.toString(), region };
  // A caller-supplied fetch opts out of the native client, so this one stays on signed requests.
  const signedCfg = { ...cfg, fetch: (input, init) => fetch(input, init) };

  describe(':::: bun native ::::', () => {
    const native = new S3mini(cfg);
    const signed = new S3mini(signedCfg);
    const prefix = `bun-native-${Date.now()}/`;
    const key = `${prefix}hello.txt`;
    const nested = `${prefix}sub/deep.txt`;
    const content = 'hello from bun';

    beforeAll(async () => {
      if (!(await native.bucketExists())) {
        await native.createBucket();
      }
    });

    afterAll(async () => {
      const left = await native.listObjects('/', prefix);
      if (left.length) {
        await native.deleteObjects(left.map(o => o.Key));
      }
    });

    it('uses Bun.S3Client only when the caller did not supply a fetch', () => {
      expect(native._bun).toBeDefined();
      expect(signed._bun).toBeUndefined();
    });

    it('reads objects through the native client with the same answers as the signed path', async () => {
      await native.putObject(key, content, 'text/plain');

      expect(await native.getObject(key)).toBe(content);
      expect(await native.getObject(key)).toBe(await signed.getObject(key));
      expect(await native.getEtag(key)).toBe(await signed.getEtag(key));
      expect(await native.getContentLength(key)).toBe(content.length);
      expect(await native.objectExists(key)).toBe(true);
      expect(await native.objectExists(`${prefix}missing.txt`)).toBe(false);
      expect(await native.getObject(`${prefix}missing.txt`)).toBeNull();

      // putObject stays on the signed path: Bun's write() rewrites 'text/plain' to
      // 'text/plain;charset=utf-8' and stringifies ReadableStreams.
      const res = await native.getObjectResponse(key);
      expect(res.headers.get('content-type')).toBe('text/plain');
    });

    it('lists flat by default and groups only when a delimiter is given', async () => {
      await native.putObject(nested, content, 'text/plain');

      const flat = await native.listObjects('/', prefix);
      expect(flat.map(o => o.Key).sort()).toEqual([key, nested].sort());
      expect(flat).toEqual(await signed.listObjects('/', prefix));
      // Bun spells the field eTag, so a mis-mapped listing silently returns empty ETags.
      expect(flat.every(o => o.ETag.length > 0)).toBe(true);
      expect(flat.every(o => typeof o.Size === 'number' && o.LastModified instanceof Date)).toBe(true);

      const grouped = await native.listObjects('/', prefix, undefined, { delimiter: '/' });
      expect(grouped.map(o => o.Key).sort()).toEqual([key, `${prefix}sub/`].sort());
    });

    // A real multi-page listing needs >1000 objects (see the pagination e2e); these drive the
    // native client with a stub so the cursor logic is checked without the upload.
    const withStubbedList = pages => {
      const client = new S3mini(cfg);
      const calls = [];
      client._bun = {
        list: async opts => {
          calls.push(opts);
          return pages[Math.min(calls.length - 1, pages.length - 1)];
        },
      };
      return { client, calls };
    };
    const entry = k => ({ key: k, size: 1, lastModified: new Date().toISOString(), eTag: '"e"' });

    it('follows continuation tokens across pages', async () => {
      const { client, calls } = withStubbedList([
        { contents: [entry('a'), entry('b')], isTruncated: true, nextContinuationToken: 'T1' },
        { contents: [entry('c')], isTruncated: false },
      ]);

      expect((await client.listObjects('/', 'p/')).map(o => o.Key)).toEqual(['a', 'b', 'c']);
      expect(calls.map(c => c.continuationToken)).toEqual([undefined, 'T1']);
    });

    it('fails loudly instead of looping when the cursor stops advancing', async () => {
      const noToken = withStubbedList([{ contents: [entry('a')], isTruncated: true }]);
      await expect(noToken.client.listObjects('/', 'p/')).rejects.toThrow(/pagination stalled/);

      const repeated = withStubbedList([
        { contents: [entry('a')], isTruncated: true, nextContinuationToken: 'SAME' },
        { contents: [entry('a')], isTruncated: true, nextContinuationToken: 'SAME' },
      ]);
      await expect(repeated.client.listObjects('/', 'p/')).rejects.toThrow(/pagination stalled/);
      expect(repeated.calls.length).toBe(2);
    });

    it('returns a satisfied maxKeys request even if the page says truncated', async () => {
      const { client } = withStubbedList([{ contents: [entry('a'), entry('b')], isTruncated: true }]);
      expect((await client.listObjects('/', 'p/', 2)).map(o => o.Key)).toEqual(['a', 'b']);
    });

    it('deletes through the native client', async () => {
      expect(await native.deleteObject(key)).toBe(true);
      expect(await native.objectExists(key)).toBe(false);
    });
  });
}
