'use strict';

import { createHash } from 'node:crypto';
import { S3mini } from '../dist/index.mjs';
import { beforeRun, resetBucketBeforeAll } from './_shared.test.js';

import * as dotenv from 'dotenv';
dotenv.config();

const name = 'minio';
const bucketName = `BUCKET_ENV_${name.toUpperCase()}`;

const raw = process.env[bucketName] ? process.env[bucketName].split(',') : null;

const minioSpecific = bucket => {
  const s3client = new S3mini({
    accessKeyId: bucket.accessKeyId,
    secretAccessKey: bucket.secretAccessKey,
    endpoint: bucket.endpoint,
    region: bucket.region,
  });

  resetBucketBeforeAll(s3client);

  it('put object with valid x-amz-checksum-sha1 header', async () => {
    const fileContents = Buffer.from('Some file contents.', 'utf-8');
    const hasher = createHash('sha1');
    hasher.setEncoding('base64');
    hasher.write(fileContents);
    hasher.end();
    const fileHash = hasher.read();

    const result = await s3client.putObject('validated-file-one.txt', fileContents, 'text/plain', undefined, {
      'x-amz-checksum-sha1': fileHash,
    });

    expect(result.ok).toBe(true);
    expect(result.headers.get('x-amz-checksum-sha1')).toBe(fileHash);
  });

  it('put object with invalid x-amz-checksum-sha1', async () => {
    const fileContents = Buffer.from('Some file contents.', 'utf-8');
    const hasher = createHash('sha1');
    hasher.setEncoding('base64');
    hasher.write(fileContents);
    hasher.write('Make the hash faulty.');
    hasher.end();
    const fileHash = hasher.read();

    let caught;
    try {
      await s3client.putObject('validated-file-two.txt', fileContents, 'text/plain', undefined, {
        'x-amz-checksum-sha1': fileHash,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('XAmzContentChecksumMismatch');
  });

  /**
   * Dedicated MinIO versioning smoke (in addition to shared E2E).
   * globalSetup enables versioning on the MinIO bucket — this must not soft-skip.
   */
  it('minio versioning is enabled and listObjectVersions returns real versions', async () => {
    const status = await s3client.getBucketVersioning();
    // setup enables versioning; also accept Off briefly if get is laggy — still require version ids
    expect(['Enabled', 'Off', 'Suspended']).toContain(status);

    if (status !== 'Enabled') {
      const ok = await s3client.setBucketVersioning('Enabled');
      expect(ok).toBe(true);
      expect(await s3client.getBucketVersioning()).toBe('Enabled');
    }

    const key = `minio-version-smoke-${Date.now()}.txt`;
    const a = await s3client.putObject(key, 'alpha', 'text/plain');
    const b = await s3client.putObject(key, 'beta', 'text/plain');
    const idA = a.headers.get('x-amz-version-id');
    const idB = b.headers.get('x-amz-version-id');
    expect(idA).toBeTruthy();
    expect(idA).not.toBe('null');
    expect(idB).toBeTruthy();
    expect(idB).not.toBe('null');
    expect(idA).not.toBe(idB);

    const versions = await s3client.listObjectVersions(key);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions.filter(v => v.IsLatest).length).toBeGreaterThanOrEqual(1);
    expect(await s3client.getObject(key, { versionId: idA })).toBe('alpha');
    expect(await s3client.getObject(key, { versionId: idB })).toBe('beta');

    await s3client.deleteObjects(versions.map(v => ({ key: v.Key, versionId: v.VersionId })));
  });
};

beforeRun(raw, name, minioSpecific);
