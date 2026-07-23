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
};

beforeRun(raw, name, minioSpecific);
