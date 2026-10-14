'use strict';
import { S3mini } from '../dist/index.mjs';

import * as dotenv from 'dotenv';
dotenv.config();

const raw = process.env.BUCKET_ENV_MINIO ? process.env.BUCKET_ENV_MINIO.split(',') : null;
// s3mini engages Bun.S3Client from Bun 1.4.0 only (see isBun in src/utils.ts).
const nativeBun = typeof globalThis.Bun?.S3Client === 'function' && Bun.semver.satisfies(Bun.version, '>=1.4.0');

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

    /**
     * A bucket that is not there is a 404 on every read, and every signed reader tolerates 404 and
     * answers null. Bun raises a typed error instead, so the mapping has to agree: matching only
     * NoSuchKey left getObject() throwing here while returning null on the signed path.
     */
    it('answers null for a bucket that is not there, exactly as the signed path does', async () => {
      const absent = new URL(ownBucket);
      absent.pathname = `/s3mini-absent-${Date.now()}`;
      const nativeAbsent = new S3mini({ ...cfg, endpoint: absent.toString() });
      const signedAbsent = new S3mini({ ...signedCfg, endpoint: absent.toString() });

      // Guard the guard: if the native client were declined here the parity below proves nothing.
      expect(nativeAbsent._bun).toBeDefined();
      expect(signedAbsent._bun).toBeUndefined();

      for (const read of [c => c.getObject(key), c => c.getObjectArrayBuffer(key)]) {
        expect(await read(nativeAbsent)).toBeNull();
        expect(await read(signedAbsent)).toBeNull();
      }
      expect(await nativeAbsent.bucketExists()).toBe(false);
      expect(await nativeAbsent.objectExists(key)).toBe(false);
    });

    it('declines the native client when the endpoint reaches past the bucket', async () => {
      // Bun takes an origin plus a bucket name, so '/bucket/prefix' collapses to '/bucket'. The
      // native client served the parent bucket's objects for this config instead of reporting
      // nothing there — a silent read of the wrong location, so it has to stay on signed requests.
      const nested = new S3mini({ ...cfg, endpoint: `${cfg.endpoint}/not-a-bucket` });

      expect(nested._bun).toBeUndefined();
      expect(nested.bucketName).toBe(native.bucketName);
      expect(await nested.listObjects()).toBeNull();
      expect(await nested.getObject(key)).toBeNull();
      // The key really is in the parent bucket, which is what makes the null above meaningful.
      expect(await native.getObject(key)).toBe(content);
    });

    it('deletes through the native client', async () => {
      expect(await native.deleteObject(key)).toBe(true);
      expect(await native.objectExists(key)).toBe(false);
    });
  });
}
