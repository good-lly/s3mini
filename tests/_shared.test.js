'use strict';

import { S3mini, sanitizeETag, runInBatches } from '../dist/s3mini.js';
import { randomBytes } from 'node:crypto';

const TRANSIENT_CODES = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET'];
const MAX_RETRIES = 2;
const PER_REQUEST_TIMEOUT_MS = 20_000;

const retryFetch = async (input, init) => {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const signal = init?.signal ?? AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS);
      return await fetch(input, { ...init, signal });
    } catch (err) {
      const code = err?.cause?.code ?? err?.code ?? '';
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const isTransient = isTimeout || TRANSIENT_CODES.some(c => code.includes(c));
      if (!isTransient || attempt === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
};

function toUint8Array(data) {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  // Node Buffer
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
    return new Uint8Array(data);
  }
  throw new Error('Unknown data type');
}

export const beforeRun = (raw, name, providerSpecific) => {
  if (!raw || raw === null) {
    console.error('No credentials found. Please set the BUCKET_ENV_ environment variables.');
    describe.skip(name, () => {
      it('skipped', () => {
        expect(true).toBe(true);
      });
    });
  } else {
    console.log('Running tests for bucket:', name);
    const credentials = {
      provider: raw[0],
      accessKeyId: raw[1],
      secretAccessKey: raw[2],
      endpoint: raw[3],
      region: raw[4],
    };
    describe(`:::: ${credentials.provider} ::::`, () => {
      expect(credentials.provider).toBe(name);
      providerName = credentials.provider;
      expect(credentials.accessKeyId).toBeDefined();
      expect(credentials.secretAccessKey).toBeDefined();
      expect(credentials.endpoint).toBeDefined();
      expect(credentials.region).toBeDefined();
      testRunner(credentials);
      if (providerSpecific) {
        providerSpecific(credentials);
      }
    });
  }
};

const EIGHT_MB = 8 * 1024 * 1024;

const large_buffer = randomBytes(EIGHT_MB * 3.2);

const byteSize = str => new Blob([str]).size;

const OP_CAP = 40;
let providerName;
const key = 'first-test-object.txt';
const contentString = 'Hello, world!';

const specialCharContentString = 'Hello, world! \uD83D\uDE00';
const specialCharContentBufferExtra = Buffer.from(specialCharContentString + ' extra', 'utf-8');
const specialCharKey = 'special-char key with spaces.txt';

export const resetBucketBeforeAll = s3client => {
  beforeAll(async () => {
    let exists;
    try {
      exists = await s3client.bucketExists();
    } catch (err) {
      // Backblaze accounts are locked to a region and may throw on HEAD
      console.warn(`Skipping bucketExists() pre-check: ${err}`);
      return;
    }
    if (exists) {
      const list = await s3client.listObjects();
      expect(list).toBeInstanceOf(Array);
      if (list.length > 0) {
        expect(list.length).toBeGreaterThan(0);

        await s3client.deleteObjects(list.map(obj => obj.Key));
      }
    }
  });
};

// --- 2 ■ A separate describe makes test output nicer -----------------------
export const testRunner = bucket => {
  const s3client = new S3mini({
    accessKeyId: bucket.accessKeyId,
    secretAccessKey: bucket.secretAccessKey,
    endpoint: bucket.endpoint,
    region: bucket.region,
    fetch: retryFetch,
  });

  resetBucketBeforeAll(s3client);

  it('instantiates s3client', () => {
    expect(s3client).toBeInstanceOf(S3mini); // ← updated expectation
  });

  it('bucket exists', async () => {
    let exists = await s3client.bucketExists();
    if (!exists) {
      const createBucketResponse = await s3client.createBucket();
      expect(createBucketResponse).toBeDefined();
      exists = await s3client.bucketExists();
    }
    expect(exists).toBe(true);

    const nonExistentBucket = new S3mini({
      accessKeyId: bucket.accessKeyId,
      secretAccessKey: bucket.secretAccessKey,
      endpoint: bucket.endpoint + '/non-existent-bucket',
      region: bucket.region,
    });
    const nonExistent = await nonExistentBucket.bucketExists();
    expect(nonExistent).toBe(false);
  });

  it('basic list objects', async () => {
    const objects = await s3client.listObjects();
    expect(objects).toBeInstanceOf(Array);
    if (objects.length > 0) {
      for (const obj of objects) {
        await s3client.deleteObject(obj.Key);
      }
    }
    // Check if the bucket is empty
    const objects2 = await s3client.listObjects();
    expect(objects2).toBeInstanceOf(Array);
    expect(objects2.length).toBe(0);

    // listing non existent prefix thros 404 no such key
    const objectsWithPrefix = await s3client.listObjects('non-existent-prefix');
    expect(objectsWithPrefix).toBe(null);
  });

  it('basic put and get object', async () => {
    await s3client.putObject(key, contentString);
    const data = await s3client.getObject(key);
    expect(data).toBe(contentString);

    // Clean up
    const delResp = await s3client.deleteObject(key);
    expect(delResp).toBe(true);

    // Check if the object is deleted
    const deletedData = await s3client.getObject(key);
    expect(deletedData).toBe(null);

    if (providerName === 'cloudflare') {
      // Test Cloudflare SSE-C
      const ssecHeaders = {
        'x-amz-server-side-encryption-customer-algorithm': 'AES256',
        'x-amz-server-side-encryption-customer-key': 'n1TKiTaVHlYLMX9n0zHXyooMr026vOiTEFfT+719Hho=',
        'x-amz-server-side-encryption-customer-key-md5': 'gepZmzgR7Be/1+K1Aw+6ow==',
      };
      const response = await s3client.putObject(key, contentString, undefined, ssecHeaders);
      expect(response).toBeDefined();
      expect(response.status).toBe(200);

      const getObjectResponse = await s3client.getObject(key, {}, ssecHeaders);
      expect(getObjectResponse).toBeDefined();
      expect(getObjectResponse).toBe(contentString);

      const wrongSsecHeaders = {
        'x-amz-server-side-encryption-customer-algorithm': 'AES256',
        'x-amz-server-side-encryption-customer-key': 'wrong-key',
        'x-amz-server-side-encryption-customer-key-md5': 'wrong-md5',
      };
      try {
        const wrongResponse = await s3client.getObject(key, {}, wrongSsecHeaders);
      } catch (err) {
        expect(err).toBeDefined();
        expect(err.message).toContain('400 – InvalidArgument');
      }

      try {
        const wrongResponse = await s3client.getObject(key);
      } catch (err) {
        expect(err).toBeDefined();
        expect(err.message).toContain('400 – InvalidRequest');
      }

      // Clean up
      const delRespSsec = await s3client.deleteObject(key);
      expect(delRespSsec).toBe(true);
    }
  });

  it('put and get object using typed arrays', async () => {
    // Uint8Array
    const u8Key = 'uint8array-test';
    const u8Payload = new TextEncoder().encode('hello from uint8array');
    await s3client.putObject(u8Key, u8Payload);
    const u8Data = await s3client.getObject(u8Key);
    expect(toUint8Array(u8Data)).toEqual(u8Payload);
    await s3client.deleteObject(u8Key);

    // ArrayBuffer
    const abKey = 'arraybuffer-test';
    const abUint8 = new TextEncoder().encode('hello from arraybuffer');
    await s3client.putObject(abKey, abUint8.buffer);
    const abData = await s3client.getObject(abKey);
    expect(toUint8Array(abData)).toEqual(abUint8);
    await s3client.deleteObject(abKey);
  });

  it('put and get object with special characters and different types', async () => {
    await s3client.putObject(specialCharKey, specialCharContentString);
    const data = await s3client.getObject(specialCharKey);
    expect(data).toEqual(specialCharContentString);

    // list objects
    const objects = await s3client.listObjects();
    expect(objects).toBeInstanceOf(Array);
    expect(objects.length).toBe(1);
    expect(objects[0].Key).toBe(specialCharKey);
    expect(parseInt(objects[0].Size)).toBe(byteSize(specialCharContentString));

    // update the object with a buffer with extra content
    // This is to test if the object can be updated with a buffer that has extra content
    await s3client.putObject(specialCharKey, specialCharContentBufferExtra);
    const updatedData = await s3client.getObjectArrayBuffer(specialCharKey);
    const bufferData = Buffer.from(updatedData);
    expect(bufferData.toString('utf-8')).toBe(specialCharContentBufferExtra.toString('utf-8'));
    expect(bufferData.length).toBe(specialCharContentBufferExtra.length);

    const getObjectLength = await s3client.getContentLength(specialCharKey);
    expect(getObjectLength).toBe(specialCharContentBufferExtra.length);

    // Put object image/png
    await s3client.putObject(specialCharKey + '.png', specialCharContentBufferExtra, 'image/png');
    // get object with image/png content type
    const imageData = await s3client.getObjectResponse(specialCharKey + '.png');
    expect(imageData).toBeDefined();
    expect(imageData.headers.get('content-type')).toBe('image/png');

    // Clean up
    const delResp = await s3client.deleteObject(specialCharKey);
    expect(delResp).toBe(true);

    // Check if the object is deleted
    const deletedData = await s3client.getObject(specialCharKey);
    expect(deletedData).toBe(null);
  });

  // putAnyObject
  it('putAnyObject: small payloads (string, ArrayBuffer, Blob)', async () => {
    const key = 'putany-small-string';
    const content = 'hello from putAnyObject';

    await s3client.putAnyObject(key, content, 'text/plain');

    const data = await s3client.getObject(key);
    expect(data).toBe(content);

    const length = await s3client.getContentLength(key);
    expect(length).toBe(byteSize(content));

    const resp = await s3client.getObjectResponse(key);
    expect(resp.headers.get('content-type')).toBe('text/plain');

    const delResp = await s3client.deleteObject(key);
    expect(delResp).toBe(true);

    // ArrayBuffer via putAnyObject (small, single PUT path)
    const abKey = 'putany-arraybuffer';
    const abUint8 = new TextEncoder().encode('hello from putAnyObject arraybuffer');
    await s3client.putAnyObject(abKey, abUint8.buffer);
    const abData = await s3client.getObject(abKey);
    expect(toUint8Array(abData)).toEqual(abUint8);
    await s3client.deleteObject(abKey);

    // Blob via putAnyObject (small, single PUT path)
    const blobKey = 'putany-blob';
    const blobContent = 'hello from blob';
    const blob = new Blob([blobContent], { type: 'text/plain' });
    await s3client.putAnyObject(blobKey, blob, 'text/plain');
    const blobData = await s3client.getObject(blobKey);
    expect(blobData).toBe(blobContent);
    const blobResp = await s3client.getObjectResponse(blobKey);
    expect(blobResp.headers.get('content-type')).toBe('text/plain');
    await s3client.deleteObject(blobKey);
  });

  // test If-Match header
  it('etag and if-match header check', async () => {
    const response = await s3client.putObject(key, contentString);
    const etag = sanitizeETag(response.headers.get('etag'));
    expect(etag).toBeDefined();
    expect(etag.length).toBe(32);

    const secondEtag = await s3client.getEtag(key);
    expect(secondEtag).toBe(etag);
    expect(secondEtag.length).toBe(32);

    const values = await s3client.getObjectWithETag(key);
    expect(values).toBeInstanceOf(Object);
    // convert arrayBuffer to string
    const decoder = new TextDecoder('utf-8');
    const content = decoder.decode(values.data);
    expect(content).toBe(contentString);
    expect(values.etag).toBe(etag);
    expect(values.etag.length).toBe(32);

    const data = await s3client.getObject(key, { 'if-match': etag });
    expect(data).toBe(contentString);

    const randomWrongEtag = 'random-wrong-etag';
    const anotherResponse = await s3client.getObject(key, { 'if-match': randomWrongEtag });
    expect(anotherResponse).toBe(null);

    const reponse2 = await s3client.getObject(key, { 'if-none-match': etag });
    expect(reponse2).toBe(null);

    const reponse3 = await s3client.getObject(key, { 'if-none-match': randomWrongEtag });
    expect(reponse3).toBe(contentString);

    // Clean up
    const delResp = await s3client.deleteObject(key);
    expect(delResp).toBe(true);

    // Check if the object is deleted
    const deletedData = await s3client.getObject(key);
    expect(deletedData).toBe(null);
  });

  it('putAnyObject: put Buffer with explicit contentLength', async () => {
    const key = 'putany-buffer-contentlength';
    const buffer = Buffer.from('buffer with known length');

    await s3client.putAnyObject(key, buffer, 'application/octet-stream', undefined, undefined, buffer.length);

    const data = await s3client.getObjectArrayBuffer(key);
    const result = Buffer.from(data);

    expect(result.equals(buffer)).toBe(true);

    const length = await s3client.getContentLength(key);
    expect(length).toBe(buffer.length);

    const delResp = await s3client.deleteObject(key);
    expect(delResp).toBe(true);
  });

  it('putAnyObject: multipart upload for large buffer', async () => {
    const key = 'putany-multipart-buffer';

    // create payload > minPartSize
    const largeSize = s3client.minPartSize + 1024;
    const buffer = Buffer.alloc(largeSize, 0x61); // 'a'

    await s3client.putAnyObject(key, buffer);

    const data = await s3client.getObjectArrayBuffer(key);
    const result = Buffer.from(data);

    expect(result.length).toBe(largeSize);
    expect(result.equals(buffer)).toBe(true);

    const length = await s3client.getContentLength(key);
    expect(length).toBe(largeSize);

    const delResp = await s3client.deleteObject(key);
    expect(delResp).toBe(true);
  });

  it('putAnyObject: put ReadableStream with unknown size', async () => {
    const key = 'putany-stream';

    const encoder = new TextEncoder();
    const chunks = ['stream ', 'upload ', 'works'];

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    await s3client.putAnyObject(key, stream, 'text/plain');

    const data = await s3client.getObject(key);
    expect(data).toBe(chunks.join(''));

    const delResp = await s3client.deleteObject(key);
    expect(delResp).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Pre-signed URL tests
  // ─────────────────────────────────────────────────────────────────────────

  it('presigned URL: PUT upload and GET download via raw fetch', async () => {
    const presignedKey = 'presigned-roundtrip.txt';
    const content = 'Hello from presigned URL!';

    // Upload via presigned PUT URL
    const putUrl = await s3client.getPresignedUrl('PUT', presignedKey, 300);
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      body: content,
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(putRes.ok).toBe(true);

    // Verify via normal S3 client
    const data = await s3client.getObject(presignedKey);
    expect(data).toBe(content);

    // Download via presigned GET URL
    const getUrl = await s3client.getPresignedUrl('GET', presignedKey, 300);
    const getRes = await fetch(getUrl);
    expect(getRes.ok).toBe(true);
    expect(await getRes.text()).toBe(content);

    // Clean up
    await s3client.deleteObject(presignedKey);
  });

  it('presigned URL: works with special characters in key', async () => {
    const presignedKey = 'presigned/path with spaces/file.txt';
    const content = 'special chars test';

    const putUrl = await s3client.getPresignedUrl('PUT', presignedKey, 300);
    const putRes = await fetch(putUrl, { method: 'PUT', body: content });
    expect(putRes.ok).toBe(true);

    const getUrl = await s3client.getPresignedUrl('GET', presignedKey, 300);
    const getRes = await fetch(getUrl);
    expect(getRes.ok).toBe(true);
    expect(await getRes.text()).toBe(content);

    await s3client.deleteObject(presignedKey);
  });

  it('presigned URL: binary content via PUT', async () => {
    const presignedKey = 'presigned-binary.bin';
    const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);

    const putUrl = await s3client.getPresignedUrl('PUT', presignedKey, 300);
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      body: binaryData,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(putRes.ok).toBe(true);

    const getUrl = await s3client.getPresignedUrl('GET', presignedKey, 300);
    const getRes = await fetch(getUrl);
    expect(getRes.ok).toBe(true);
    const downloaded = new Uint8Array(await getRes.arrayBuffer());
    expect(downloaded).toEqual(binaryData);

    await s3client.deleteObject(presignedKey);
  });

  it('presigned URL: overwrite existing object via PUT', async () => {
    const presignedKey = 'presigned-overwrite.txt';
    const original = 'original content';
    const updated = 'updated content';

    // Upload original via SDK
    await s3client.putObject(presignedKey, original);
    expect(await s3client.getObject(presignedKey)).toBe(original);

    // Overwrite via presigned PUT
    const putUrl = await s3client.getPresignedUrl('PUT', presignedKey, 300);
    const putRes = await fetch(putUrl, { method: 'PUT', body: updated });
    expect(putRes.ok).toBe(true);

    // Verify overwrite via presigned GET
    const getUrl = await s3client.getPresignedUrl('GET', presignedKey, 300);
    const getRes = await fetch(getUrl);
    expect(getRes.ok).toBe(true);
    expect(await getRes.text()).toBe(updated);

    await s3client.deleteObject(presignedKey);
  });

  it('presigned URL: nested deep key path', async () => {
    const presignedKey = 'presigned/deeply/nested/dir/structure/file.json';
    const content = JSON.stringify({ ok: true });

    const putUrl = await s3client.getPresignedUrl('PUT', presignedKey, 300);
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      body: content,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(putRes.ok).toBe(true);

    const getUrl = await s3client.getPresignedUrl('GET', presignedKey, 300);
    const getRes = await fetch(getUrl);
    expect(getRes.ok).toBe(true);
    expect(await getRes.text()).toBe(content);

    await s3client.deleteObject(presignedKey);
  });

  it('presigned URL: larger payload (~256 KB)', async () => {
    const presignedKey = 'presigned-large.bin';
    const largePayload = randomBytes(256 * 1024);

    const putUrl = await s3client.getPresignedUrl('PUT', presignedKey, 300);
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      body: largePayload,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(putRes.ok).toBe(true);

    const getUrl = await s3client.getPresignedUrl('GET', presignedKey, 300);
    const getRes = await fetch(getUrl);
    expect(getRes.ok).toBe(true);
    const downloaded = new Uint8Array(await getRes.arrayBuffer());
    expect(downloaded.byteLength).toBe(largePayload.byteLength);
    expect(Buffer.compare(Buffer.from(downloaded), largePayload)).toBe(0);

    await s3client.deleteObject(presignedKey);
  });

  it('presigned URL: PUT with signed Content-Type header roundtrip', async () => {
    const presignedKey = 'presigned-signed-header.txt';
    const content = 'Hello with signed Content-Type!';
    const contentType = 'text/plain';

    const putUrl = await s3client.getPresignedUrl('PUT', presignedKey, 300, {}, {
      'Content-Type': contentType,
    });
    const parsed = new URL(putUrl);
    const signedHeaders = parsed.searchParams.get('X-Amz-SignedHeaders');
    expect(signedHeaders).toContain('content-type');
    expect(signedHeaders).toContain('host');

    const putRes = await fetch(putUrl, {
      method: 'PUT',
      body: content,
      headers: { 'Content-Type': contentType },
    });
    expect(putRes.ok).toBe(true);

    const data = await s3client.getObject(presignedKey);
    expect(data).toBe(content);

    const getUrl = await s3client.getPresignedUrl('GET', presignedKey, 300);
    const getRes = await fetch(getUrl);
    expect(getRes.ok).toBe(true);
    expect(await getRes.text()).toBe(content);

    await s3client.deleteObject(presignedKey);
  });

  it('presigned URL: PUT with signed Content-Type rejects mismatched header', async () => {
    const presignedKey = 'presigned-mismatch-header.txt';
    const content = 'Should fail with wrong Content-Type';

    const putUrl = await s3client.getPresignedUrl('PUT', presignedKey, 300, {}, {
      'Content-Type': 'text/plain',
    });

    const putRes = await fetch(putUrl, {
      method: 'PUT',
      body: content,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(putRes.ok).toBe(false);
    expect(putRes.status).toBe(403);
  });

  // list multipart uploads and abort them
  it('list multipart uploads and abort them all', async () => {
    let multipartUpload;
    do {
      multipartUpload = await s3client.listMultipartUploads();
      expect(multipartUpload).toBeDefined();
      expect(typeof multipartUpload).toBe('object');
      if (!multipartUpload.uploadId || !multipartUpload.Key) {
        break;
      }
      const abortUploadResponse = await s3client.abortMultipartUpload(multipartUpload.Key, multipartUpload.uploadId);
      expect(abortUploadResponse).toBeDefined();
      expect(abortUploadResponse.status).toBe('Aborted');
      expect(abortUploadResponse.Key).toEqual(multipartUpload.Key);
      expect(abortUploadResponse.uploadId).toEqual(multipartUpload.uploadId);
    } while (multipartUpload.uploadId && multipartUpload.Key);

    const multipartUpload2 = await s3client.listMultipartUploads();
    expect(multipartUpload2).toBeDefined();
    expect(typeof multipartUpload2).toBe('object');
    expect(multipartUpload2).not.toHaveProperty('key');
    expect(multipartUpload2).not.toHaveProperty('uploadId');
  });

  it('concurrent putAnyObject calls do not interfere with each other', async () => {
    const keys = ['concurrent-opt-1', 'concurrent-opt-2', 'concurrent-opt-3', 'concurrent-opt-4'];
    const size = s3client.minPartSize + 1024; // Force multipart

    // Create distinct content for each file
    const buffers = keys.map((_, i) => {
      const buf = Buffer.alloc(size);
      buf.fill(0x41 + i); // 'A', 'B', 'C', 'D'
      return buf;
    });

    // Upload ALL concurrently - this is the critical test
    const results = await Promise.all(keys.map((key, i) => s3client.putAnyObject(key, buffers[i])));

    // All should succeed
    for (const result of results) {
      expect(result.ok || result.status === 200).toBe(true);
    }

    // Verify each file has correct, distinct content
    for (let i = 0; i < keys.length; i++) {
      const data = await s3client.getObjectArrayBuffer(keys[i]);
      const result = Buffer.from(data);

      expect(result.length).toBe(size);
      // Check first and last bytes match expected pattern
      expect(result[0]).toBe(0x41 + i);
      expect(result[result.length - 1]).toBe(0x41 + i);
      // Verify entire content
      expect(result.every(b => b === 0x41 + i)).toBe(true);
    }

    // Cleanup
    await s3client.deleteObjects(keys);
  });

  it('interleaved concurrent uploads with different sizes', async () => {
    const uploads = [
      { key: 'interleaved-small', size: 1024, fill: 0x31 }, // Below threshold - single PUT
      { key: 'interleaved-exact', size: s3client.minPartSize, fill: 0x32 }, // Exactly threshold - single PUT
      { key: 'interleaved-multi-2', size: s3client.minPartSize + 100, fill: 0x33 }, // 2 parts
      { key: 'interleaved-multi-3', size: s3client.minPartSize * 2 + 100, fill: 0x34 }, // 3 parts
    ];

    const buffers = uploads.map(u => {
      const buf = Buffer.alloc(u.size);
      buf.fill(u.fill);
      return buf;
    });

    // Fire all concurrently
    const results = await Promise.all(uploads.map((u, i) => s3client.putAnyObject(u.key, buffers[i])));

    // Verify all succeeded
    for (const result of results) {
      expect(result.ok || result.status === 200).toBe(true);
    }

    // Verify content integrity
    for (let i = 0; i < uploads.length; i++) {
      const length = await s3client.getContentLength(uploads[i].key);
      expect(length).toBe(uploads[i].size);

      const data = await s3client.getObjectArrayBuffer(uploads[i].key);
      const buf = Buffer.from(data);
      expect(buf.every(b => b === uploads[i].fill)).toBe(true);
    }

    // Cleanup
    await s3client.deleteObjects(uploads.map(u => u.key));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Boundary condition tests
  // ─────────────────────────────────────────────────────────────────────────

  it('handles exactly minPartSize (single PUT, no multipart)', async () => {
    const key = 'exact-boundary-opt';
    const buffer = Buffer.alloc(s3client.minPartSize, 0x45); // 'E'

    const result = await s3client.putAnyObject(key, buffer);
    expect(result.ok || result.status === 200).toBe(true);

    const length = await s3client.getContentLength(key);
    expect(length).toBe(s3client.minPartSize);

    // Verify ETag is simple (not multipart format with -N suffix)
    const etag = await s3client.getEtag(key);
    expect(etag).toBeDefined();
    expect(etag.length).toBe(32); // Simple MD5, no -N suffix

    await s3client.deleteObject(key);
  });

  it('handles minPartSize + 1 byte (triggers 2-part multipart)', async () => {
    const key = 'boundary-plus-one-opt';
    const size = s3client.minPartSize + 1;
    const buffer = Buffer.alloc(size, 0x46); // 'F'

    const result = await s3client.putAnyObject(key, buffer);
    expect(result.ok || result.status === 200).toBe(true);

    const length = await s3client.getContentLength(key);
    expect(length).toBe(size);

    // Verify ETag has multipart format (32 hex chars + dash + part count)
    const etag = await s3client.getEtag(key);
    expect(etag).toBeDefined();
    expect(etag.length).toBe(34); // 32 + '-2'

    // Verify content integrity
    const data = await s3client.getObjectArrayBuffer(key);
    const result2 = Buffer.from(data);
    expect(result2.every(b => b === 0x46)).toBe(true);

    await s3client.deleteObject(key);
  });

  it('handles 2 * minPartSize + 1 byte (3 parts, last is 1 byte)', async () => {
    const key = 'three-parts-tiny-last-opt';
    const size = s3client.minPartSize * 2 + 1;
    const buffer = Buffer.alloc(size, 0x48); // 'H'

    const result = await s3client.putAnyObject(key, buffer);
    expect(result.ok || result.status === 200).toBe(true);

    const length = await s3client.getContentLength(key);
    expect(length).toBe(size);

    const etag = await s3client.getEtag(key);
    expect(etag.length).toBe(34); // 32 + '-3'

    // Verify content
    const data = await s3client.getObjectArrayBuffer(key);
    expect(Buffer.from(data).every(b => b === 0x48)).toBe(true);

    await s3client.deleteObject(key);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Data type tests with multipart
  // ─────────────────────────────────────────────────────────────────────────

  it('Blob multipart upload preserves content', async () => {
    const key = 'blob-multipart-opt';
    const size = s3client.minPartSize * 2 + 5000;
    const content = 'B'.repeat(size);
    const blob = new Blob([content], { type: 'text/plain' });

    const result = await s3client.putAnyObject(key, blob, 'text/plain');
    expect(result.ok || result.status === 200).toBe(true);

    // if cloudflare skip this check as content length is not returned
    // for some reason, CF does not return content-length for multipart uploaded objects of Blobs :shrug:
    if (providerName !== 'cloudflare') {
      const length = await s3client.getContentLength(key);
      expect(length).toBe(size);
    }

    const data = await s3client.getObject(key);
    expect(data).toBe(content);

    const response = await s3client.getObjectResponse(key);
    expect(response.headers.get('content-type')).toBe('text/plain');

    await s3client.deleteObject(key);

    // File-like binary Blob
    const binKey = 'file-blob-multipart-opt';
    const binSize = s3client.minPartSize + 2048;
    const binBuffer = Buffer.alloc(binSize, 0x49); // 'I'
    const binBlob = new Blob([binBuffer], { type: 'application/octet-stream' });

    const binResult = await s3client.putAnyObject(binKey, binBlob);
    expect(binResult.ok || binResult.status === 200).toBe(true);

    const binData = await s3client.getObjectArrayBuffer(binKey);
    expect(Buffer.from(binData).every(b => b === 0x49)).toBe(true);

    await s3client.deleteObject(binKey);
  });

  it('Uint8Array and ArrayBuffer multipart upload', async () => {
    // Uint8Array (zero-copy path)
    const key = 'uint8array-multipart-opt';
    const size = s3client.minPartSize * 2 + 1000;
    const uint8 = new Uint8Array(size).fill(0x4a); // 'J'

    const result = await s3client.putAnyObject(key, uint8);
    expect(result.ok || result.status === 200).toBe(true);

    const data = await s3client.getObjectArrayBuffer(key);
    expect(new Uint8Array(data).every(b => b === 0x4a)).toBe(true);

    await s3client.deleteObject(key);

    // ArrayBuffer (converted to Uint8Array internally)
    const abKey = 'arraybuffer-multipart-opt';
    const abSize = s3client.minPartSize + 512;
    const ab = new ArrayBuffer(abSize);
    new Uint8Array(ab).fill(0x4b); // 'K'

    const abResult = await s3client.putAnyObject(abKey, ab);
    expect(abResult.ok || abResult.status === 200).toBe(true);

    const abData = await s3client.getObjectArrayBuffer(abKey);
    expect(new Uint8Array(abData).every(b => b === 0x4b)).toBe(true);

    await s3client.deleteObject(abKey);
  });

  it('String multipart upload (large text)', async () => {
    const key = 'string-multipart-opt';
    const content = 'L'.repeat(s3client.minPartSize + 3000);

    const result = await s3client.putAnyObject(key, content, 'text/plain');
    expect(result.ok || result.status === 200).toBe(true);

    const data = await s3client.getObject(key);
    expect(data).toBe(content);

    await s3client.deleteObject(key);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ReadableStream tests (streaming path)
  // ─────────────────────────────────────────────────────────────────────────

  it('ReadableStream multipart upload', async () => {
    const key = 'stream-multipart-opt';
    const chunkSize = 1024 * 1024; // 1MB chunks
    const totalChunks = Math.ceil((s3client.minPartSize * 2 + 5000) / chunkSize);
    const expectedSize = totalChunks * chunkSize;

    let chunksEmitted = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (chunksEmitted >= totalChunks) {
          controller.close();
          return;
        }
        const chunk = new Uint8Array(chunkSize).fill(0x4d); // 'M'
        controller.enqueue(chunk);
        chunksEmitted++;
      },
    });

    const result = await s3client.putAnyObject(key, stream);
    expect(result.ok || result.status === 200).toBe(true);

    const length = await s3client.getContentLength(key);
    expect(length).toBe(expectedSize);

    // Verify content
    const data = await s3client.getObjectArrayBuffer(key);
    expect(new Uint8Array(data).every(b => b === 0x4d)).toBe(true);

    await s3client.deleteObject(key);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Large file test (memory efficiency)
  // ─────────────────────────────────────────────────────────────────────────

  it('large multipart upload (3+ parts) maintains integrity', async () => {
    const key = 'large-multipart-opt';
    const size = Math.ceil(s3client.minPartSize * 3.2);
    const buffer = randomBytes(size);

    const result = await s3client.putAnyObject(key, buffer);
    expect(result.ok || result.status === 200).toBe(true);

    const length = await s3client.getContentLength(key);
    expect(length).toBe(size);

    // Verify by downloading and comparing
    const downloaded = await s3client.getObjectArrayBuffer(key);
    const downloadedBuf = Buffer.from(downloaded);
    expect(downloadedBuf.equals(buffer)).toBe(true);

    await s3client.deleteObject(key);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Error handling and edge cases
  // ─────────────────────────────────────────────────────────────────────────

  it('empty content uses single PUT', async () => {
    const key = 'empty-opt';
    const result = await s3client.putAnyObject(key, '');
    expect(result.ok || result.status === 200).toBe(true);

    const length = await s3client.getContentLength(key);
    expect(length).toBe(0);

    await s3client.deleteObject(key);
  });

  it('handles unicode content correctly', async () => {
    const key = 'unicode-multipart-opt';
    // Create content with unicode that will exceed minPartSize when encoded
    const unicodeChars = '🚀🎉✨💡🔥';
    const repeatCount = Math.ceil((s3client.minPartSize + 100) / (unicodeChars.length * 4));
    const content = unicodeChars.repeat(repeatCount);

    const result = await s3client.putAnyObject(key, content, 'text/plain; charset=utf-8');
    expect(result.ok || result.status === 200).toBe(true);

    const data = await s3client.getObject(key);
    expect(data).toBe(content);

    await s3client.deleteObject(key);
  });

  it('special characters in key with multipart', async () => {
    const key = 'special key with spaces & symbols!@#.bin';
    const size = s3client.minPartSize + 100;
    const buffer = Buffer.alloc(size, 0x4e);

    const result = await s3client.putAnyObject(key, buffer);
    expect(result.ok || result.status === 200).toBe(true);

    const data = await s3client.getObjectArrayBuffer(key);
    expect(Buffer.from(data).every(b => b === 0x4e)).toBe(true);

    await s3client.deleteObject(key);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Comparison test: putAnyObject vs manual multipart
  // ─────────────────────────────────────────────────────────────────────────

  it('putAnyObject produces same result as manual multipart upload', async () => {
    const keyAuto = 'auto-multipart';
    const keyManual = 'manual-multipart';
    const size = s3client.minPartSize * 2 + 1234;
    const buffer = randomBytes(size);

    // Auto upload
    await s3client.putAnyObject(keyAuto, buffer);

    // Manual multipart
    const uploadId = await s3client.getMultipartUploadId(keyManual);
    const parts = [];
    const partSize = s3client.minPartSize;

    for (let i = 0; i * partSize < size; i++) {
      const start = i * partSize;
      const end = Math.min(start + partSize, size);
      const partData = buffer.subarray(start, end);
      const part = await s3client.uploadPart(keyManual, uploadId, partData, i + 1);
      parts.push(part);
    }
    await s3client.completeMultipartUpload(keyManual, uploadId, parts);

    // Compare
    const autoData = await s3client.getObjectArrayBuffer(keyAuto);
    const manualData = await s3client.getObjectArrayBuffer(keyManual);

    expect(Buffer.from(autoData).equals(Buffer.from(manualData))).toBe(true);
    expect(Buffer.from(autoData).equals(buffer)).toBe(true);

    await s3client.deleteObjects([keyAuto, keyManual]);
  });

  // multipart upload and download
  it('multipart upload and download', async () => {
    const multipartKey = 'multipart-object.txt';
    const partSize = EIGHT_MB; // 8 MB
    const totalParts = Math.ceil(large_buffer.length / partSize);
    const uploadId = await s3client.getMultipartUploadId(multipartKey);

    const uploadPromises = [];
    for (let i = 0; i < totalParts; i++) {
      const partBuffer = large_buffer.subarray(i * partSize, (i + 1) * partSize);
      uploadPromises.push(s3client.uploadPart(multipartKey, uploadId, partBuffer, i + 1));
    }
    const uploadResponses = await Promise.all(uploadPromises);

    const parts = uploadResponses.map((response, index) => ({
      partNumber: index + 1,
      etag: response.etag,
    }));

    const completeResponse = await s3client.completeMultipartUpload(multipartKey, uploadId, parts);
    expect(completeResponse).toBeDefined();
    expect(typeof completeResponse).toBe('object');
    const etag = completeResponse.etag;
    expect(etag).toBeDefined();
    expect(typeof etag).toBe('string');
    if (etag.length !== 34) {
      console.warn(`Warning: ETag length is unexpected: ${etag.length} (ETag: ${etag})`);
    }
    expect(etag.length).toBe(32 + 2); // 32 chars + 2 number of parts flag

    const dataArrayBuffer = await s3client.getObjectArrayBuffer(multipartKey);
    const dataBuffer = Buffer.from(dataArrayBuffer);
    expect(dataBuffer).toBeInstanceOf(Buffer);
    expect(dataBuffer.toString('utf-8')).toBe(large_buffer.toString('utf-8'));

    const multipartUpload = await s3client.listMultipartUploads();
    expect(multipartUpload).toBeDefined();
    expect(typeof multipartUpload).toBe('object');
    expect(multipartUpload).not.toHaveProperty('key');
    expect(multipartUpload).not.toHaveProperty('uploadId');

    if (providerName === 'cloudflare') {
      // Cloudflare SSE-C multipart upload
      const ssecHeaders = {
        'x-amz-server-side-encryption-customer-algorithm': 'AES256',
        'x-amz-server-side-encryption-customer-key': 'n1TKiTaVHlYLMX9n0zHXyooMr026vOiTEFfT+719Hho=',
        'x-amz-server-side-encryption-customer-key-md5': 'gepZmzgR7Be/1+K1Aw+6ow==',
      };
      const multipartKeySsec = 'multipart-object-ssec.txt';
      const uploadIdSsec = await s3client.getMultipartUploadId(multipartKeySsec, 'text/plain', ssecHeaders);
      const uploadPromises = [];
      for (let i = 0; i < totalParts; i++) {
        const partBuffer = large_buffer.subarray(i * partSize, (i + 1) * partSize);
        uploadPromises.push(
          s3client.uploadPart(multipartKeySsec, uploadIdSsec, partBuffer, i + 1, undefined, ssecHeaders),
        );
      }
      const uploadResponses = await Promise.all(uploadPromises);

      const parts = uploadResponses.map((response, index) => ({
        partNumber: index + 1,
        etag: response.etag,
      }));

      const completeResponse = await s3client.completeMultipartUpload(multipartKeySsec, uploadIdSsec, parts);
      expect(completeResponse).toBeDefined();
      expect(typeof completeResponse).toBe('object');
      const etagSsec = completeResponse.etag;
      expect(etagSsec).toBeDefined();
      expect(typeof etagSsec).toBe('string');
    }

    // lets test getObjectRaw with range
    const rangeStart = 2048 * 1024; // 2 MB
    const rangeEnd = 8 * 1024 * 1024 * 2; // 16 MB
    const rangeResponse = await s3client.getObjectRaw(multipartKey, false, rangeStart, rangeEnd);
    const rangeData = await rangeResponse.arrayBuffer();
    expect(rangeResponse).toBeDefined();

    expect(rangeData).toBeInstanceOf(ArrayBuffer);
    const rangeBuffer = Buffer.from(rangeData);
    expect(rangeBuffer.toString('utf-8')).toBe(large_buffer.subarray(rangeStart, rangeEnd).toString('utf-8'));

    // Open-ended range: bytes=EIGHT_MB- (from 8MB to end)
    const openRangeStart = EIGHT_MB;
    const openRangeResponse = await s3client.getObjectRaw(multipartKey, false, openRangeStart, undefined);
    expect(openRangeResponse.ok).toBe(true);
    expect(openRangeResponse.status).toBe(206);
    const openRangeData = await openRangeResponse.arrayBuffer();
    const openRangeBuffer = Buffer.from(openRangeData);
    expect(openRangeBuffer.length).toBe(large_buffer.length - openRangeStart);
    expect(openRangeBuffer.toString('utf-8')).toBe(large_buffer.subarray(openRangeStart).toString('utf-8'));
    const contentRange = openRangeResponse.headers.get('content-range');
    expect(contentRange).toMatch(new RegExp(`^bytes ${openRangeStart}-\\d+/${large_buffer.length}$`));

    const objectExists = await s3client.objectExists(multipartKey);
    expect(objectExists).toBe(true);
    const objectSize = await s3client.getContentLength(multipartKey);
    expect(objectSize).toBe(large_buffer.length);
    const objectEtag = await s3client.getEtag(multipartKey);
    expect(objectEtag).toBe(etag);
    expect(objectEtag.length).toBe(32 + 2); // 32 chars + 2 number of parts flag

    // test getEtag with opts mis/match
    const etagMatch = await s3client.getEtag(multipartKey, { 'if-match': etag });
    expect(etagMatch).toBe(etag);

    const etagMismatch = await s3client.getEtag(multipartKey, { 'if-match': 'wrong-etag' });
    expect(etagMismatch).toBe(null);

    const delResp = await s3client.deleteObject(multipartKey);
    expect(delResp).toBe(true);

    const objectExists2 = await s3client.objectExists(multipartKey);
    expect(objectExists2).toBe(false);

    const deletedData = await s3client.getObject(multipartKey);
    expect(deletedData).toBe(null);
  });

  // Add these tests within the testRunner function, after the existing tests

  it('copy object within same bucket', async () => {
    const sourceKey = 'copy-source.txt';
    const destKey = 'copy-destination.txt';
    const content = 'Content to be copied';

    // Setup: create source object
    await s3client.putObject(sourceKey, content, 'text/plain');

    // Basic copy
    const copyResult = await s3client.copyObject(sourceKey, destKey);
    expect(copyResult).toBeDefined();
    expect(copyResult.etag).toBeDefined();
    expect(copyResult.etag.length).toBeGreaterThanOrEqual(32);

    // Verify both objects exist
    const sourceData = await s3client.getObject(sourceKey);
    const destData = await s3client.getObject(destKey);
    expect(sourceData).toBe(content);
    expect(destData).toBe(content);

    // Copy with metadata replacement
    const destKey2 = 'copy-with-metadata.txt';
    const copyResult2 = await s3client.copyObject(sourceKey, destKey2, {
      metadataDirective: 'REPLACE',
      metadata: {
        'custom-key': 'custom-value',
        'another-key': 'another-value',
      },
      contentType: 'text/markdown',
    });
    expect(copyResult2).toBeDefined();
    expect(copyResult2.etag).toBeDefined();

    // Verify the new object exists
    const destData2 = await s3client.getObjectResponse(destKey2);
    expect(destData2).toBeDefined();
    expect(destData2.headers.get('content-type')).toBe('text/markdown');
    const destContent2 = await destData2.text();
    expect(destContent2).toBe(content);

    // Copy with special characters
    const specialSourceKey = 'special source key with spaces & chars!.txt';
    const specialDestKey = 'special dest key with spaces & chars!.txt';
    await s3client.putObject(specialSourceKey, content);

    const copyResult3 = await s3client.copyObject(specialSourceKey, specialDestKey);
    expect(copyResult3).toBeDefined();
    expect(copyResult3.etag).toBeDefined();

    const specialData = await s3client.getObject(specialDestKey);
    expect(specialData).toBe(content);

    // Cleanup
    await s3client.deleteObjects([sourceKey, destKey, destKey2, specialSourceKey, specialDestKey]);

    // Verify cleanup
    expect(await s3client.objectExists(sourceKey)).toBe(false);
    expect(await s3client.objectExists(destKey)).toBe(false);
    expect(await s3client.objectExists(destKey2)).toBe(false);
  });

  it('move object within same bucket', async () => {
    const sourceKey = 'move-source.txt';
    const destKey = 'move-destination.txt';
    const content = 'Content to be moved';

    // Setup: create source object
    const putResult = await s3client.putObject(sourceKey, content, 'text/plain');
    const originalEtag = sanitizeETag(putResult.headers.get('etag'));
    expect(originalEtag).toBeDefined();

    // Verify source exists
    expect(await s3client.objectExists(sourceKey)).toBe(true);

    // Move the object
    const moveResult = await s3client.moveObject(sourceKey, destKey);
    expect(moveResult).toBeDefined();
    expect(moveResult.etag).toBeDefined();

    // Verify source no longer exists
    expect(await s3client.objectExists(sourceKey)).toBe(false);
    const sourceData = await s3client.getObject(sourceKey);
    expect(sourceData).toBe(null);

    // Verify destination exists with same content
    expect(await s3client.objectExists(destKey)).toBe(true);
    const destData = await s3client.getObject(destKey);
    expect(destData).toBe(content);

    // Move with metadata replacement
    const destKey2 = 'move-with-metadata.txt';
    await s3client.putObject('temp-source.txt', content);

    const moveResult2 = await s3client.moveObject('temp-source.txt', destKey2, {
      metadataDirective: 'REPLACE',
      metadata: {
        moved: 'true',
        timestamp: new Date().toISOString(),
      },
      contentType: 'application/json',
    });
    expect(moveResult2).toBeDefined();
    expect(moveResult2.etag).toBeDefined();

    // Verify source deleted and destination exists
    expect(await s3client.objectExists('temp-source.txt')).toBe(false);
    const destResponse2 = await s3client.getObjectResponse(destKey2);
    expect(destResponse2).toBeDefined();
    expect(destResponse2.headers.get('content-type')).toBe('application/json');

    // Move with special characters
    const specialSourceKey = 'special move source & chars!.txt';
    const specialDestKey = 'special move dest & chars!.txt';
    await s3client.putObject(specialSourceKey, content);

    const moveResult3 = await s3client.moveObject(specialSourceKey, specialDestKey);
    expect(moveResult3).toBeDefined();

    expect(await s3client.objectExists(specialSourceKey)).toBe(false);
    expect(await s3client.objectExists(specialDestKey)).toBe(true);

    // Cleanup
    await s3client.deleteObjects([destKey, destKey2, specialDestKey]);

    // Verify cleanup
    expect(await s3client.objectExists(destKey)).toBe(false);
    expect(await s3client.objectExists(destKey2)).toBe(false);
    expect(await s3client.objectExists(specialDestKey)).toBe(false);
  });

  it('copy and move large multipart object', async () => {
    const sourceKey = 'large-copy-source.bin';
    const copyDestKey = 'large-copy-dest.bin';
    const moveDestKey = 'large-move-dest.bin';

    // Create a large object using multipart upload
    const partSize = EIGHT_MB;
    const totalParts = Math.ceil(large_buffer.length / partSize);
    const uploadId = await s3client.getMultipartUploadId(sourceKey);

    const uploadPromises = [];
    for (let i = 0; i < totalParts; i++) {
      const partBuffer = large_buffer.subarray(i * partSize, (i + 1) * partSize);
      uploadPromises.push(s3client.uploadPart(sourceKey, uploadId, partBuffer, i + 1));
    }

    const uploadResponses = await Promise.all(uploadPromises);
    const parts = uploadResponses.map((response, index) => ({
      partNumber: index + 1,
      etag: response.etag,
    }));

    const completeResponse = await s3client.completeMultipartUpload(sourceKey, uploadId, parts);
    expect(completeResponse.etag).toBeDefined();

    // Copy the large object
    const copyResult = await s3client.copyObject(sourceKey, copyDestKey);
    expect(copyResult).toBeDefined();
    expect(copyResult.etag).toBeDefined();

    // Verify both exist and have same size
    const sourceLength = await s3client.getContentLength(sourceKey);
    const copyLength = await s3client.getContentLength(copyDestKey);
    expect(copyLength).toBe(sourceLength);
    expect(copyLength).toBe(large_buffer.length);

    // Move the copy to another location
    const moveResult = await s3client.moveObject(copyDestKey, moveDestKey);
    expect(moveResult).toBeDefined();

    // Verify move worked
    expect(await s3client.objectExists(copyDestKey)).toBe(false);
    expect(await s3client.objectExists(moveDestKey)).toBe(true);

    const moveLength = await s3client.getContentLength(moveDestKey);
    expect(moveLength).toBe(large_buffer.length);

    // Cleanup
    await s3client.deleteObjects([sourceKey, moveDestKey]);
    expect(await s3client.objectExists(sourceKey)).toBe(false);
    expect(await s3client.objectExists(moveDestKey)).toBe(false);
  });

  // Add Cloudflare-specific SSE-C tests if needed
  if (providerName === 'cloudflare') {
    it('copy and move with SSE-C encryption', async () => {
      const ssecHeaders = {
        'x-amz-server-side-encryption-customer-algorithm': 'AES256',
        'x-amz-server-side-encryption-customer-key': 'n1TKiTaVHlYLMX9n0zHXyooMr026vOiTEFfT+719Hho=',
        'x-amz-server-side-encryption-customer-key-md5': 'gepZmzgR7Be/1+K1Aw+6ow==',
      };

      const sourceKey = 'ssec-copy-source.txt';
      const destKey = 'ssec-copy-dest.txt';
      const content = 'Encrypted content';

      // Create encrypted source
      await s3client.putObject(sourceKey, content, 'text/plain', ssecHeaders);

      // Copy with SSE-C (both source and destination encrypted)
      const copyResult = await s3client.copyObject(sourceKey, destKey, {
        sourceSSECHeaders: {
          'x-amz-copy-source-server-side-encryption-customer-algorithm': 'AES256',
          'x-amz-copy-source-server-side-encryption-customer-key': 'n1TKiTaVHlYLMX9n0zHXyooMr026vOiTEFfT+719Hho=',
          'x-amz-copy-source-server-side-encryption-customer-key-md5': 'gepZmzgR7Be/1+K1Aw+6ow==',
        },
        destinationSSECHeaders: ssecHeaders,
      });

      expect(copyResult).toBeDefined();
      expect(copyResult.etag).toBeDefined();

      // Verify destination is encrypted and has correct content
      const destData = await s3client.getObject(destKey, {}, ssecHeaders);
      expect(destData).toBe(content);

      // Try to read without encryption headers (should fail)
      try {
        await s3client.getObject(destKey);
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeDefined();
        expect(err.message).toContain('400');
      }

      // Cleanup
      await s3client.deleteObjects([sourceKey, destKey]);
    });
  }

  it('extensive list objects', async () => {
    const prefix = `test-prefix-${Date.now()}/`;
    const objAll = await s3client.listObjects('/', prefix);
    expect(objAll).toEqual([]);
    expect(objAll).toBeInstanceOf(Array);
    expect(objAll).toHaveLength(0);

    await Promise.all([
      s3client.putObject(`${prefix}object1.txt`, contentString),
      s3client.putObject(`${prefix}object2.txt`, contentString),
      s3client.putObject(`${prefix}object3.txt`, contentString),
    ]);

    const objsUnlimited = await s3client.listObjects('/', prefix);
    expect(objsUnlimited).toBeInstanceOf(Array);
    expect(objsUnlimited).toHaveLength(3);

    const objsLimited = await s3client.listObjects('/', prefix, 2);
    expect(objsLimited).toBeInstanceOf(Array);
    expect(objsLimited).toHaveLength(2);
    expect(objsLimited[0].Key).toBe(`${prefix}object1.txt`);
    expect(objsLimited[1].Key).toBe(`${prefix}object2.txt`);

    // await Promise.all(objsUnlimited.map(o => s3client.deleteObject(o.key)));
    await s3client.deleteObjects(objsUnlimited.map(o => o.Key));
    expect(await s3client.listObjects('/', prefix)).toEqual([]);
  });

  it('lists objects with delimiter and returns CommonPrefixes', async () => {
    const basePrefix = `delimiter-test-${Date.now()}/`;

    // Create nested structure:
    // basePrefix/file1.txt
    // basePrefix/file2.txt
    // basePrefix/subdir1/nested1.txt
    // basePrefix/subdir1/nested2.txt
    // basePrefix/subdir2/deep/file.txt
    await Promise.all([
      s3client.putObject(`${basePrefix}file1.txt`, 'root file 1'),
      s3client.putObject(`${basePrefix}file2.txt`, 'root file 2'),
      s3client.putObject(`${basePrefix}subdir1/nested1.txt`, 'nested 1'),
      s3client.putObject(`${basePrefix}subdir1/nested2.txt`, 'nested 2'),
      s3client.putObject(`${basePrefix}subdir2/deep/file.txt`, 'deep nested'),
    ]);

    // List with delimiter - should get files + CommonPrefixes (subdirs)
    const result = await s3client.listObjects('/', basePrefix, undefined, {
      delimiter: '/',
    });

    expect(result).toBeInstanceOf(Array);

    // Should have 2 files + 2 directory prefixes = 4 items
    expect(result).toHaveLength(4);

    // Separate files from directory prefixes
    const files = result.filter(o => !o.Key.endsWith('/'));
    const prefixes = result.filter(o => o.Key.endsWith('/'));

    // Verify files
    expect(files).toHaveLength(2);
    const fileKeys = files.map(f => f.Key).sort();
    expect(fileKeys).toEqual([`${basePrefix}file1.txt`, `${basePrefix}file2.txt`]);
    // Real files should have non-zero size and valid ETag
    for (const file of files) {
      expect(parseInt(String(file.Size))).toBeGreaterThan(0);
      expect(file.ETag).toBeTruthy();
    }

    // Verify directory prefixes (CommonPrefixes)
    expect(prefixes).toHaveLength(2);
    const prefixKeys = prefixes.map(p => p.Key).sort();
    expect(prefixKeys).toEqual([`${basePrefix}subdir1/`, `${basePrefix}subdir2/`]);
    // Synthetic prefix objects should have Size=0 and empty ETag
    for (const prefix of prefixes) {
      expect(parseInt(String(prefix.Size))).toBe(0);
      expect(prefix.ETag).toBe('');
    }

    // Without delimiter - should get all 5 objects flat
    const flatResult = await s3client.listObjects('/', basePrefix);
    expect(flatResult).toHaveLength(5);
    expect(flatResult.every(o => !o.Key.endsWith('/'))).toBe(true);

    // Test nested listing with delimiter
    const subdir1Result = await s3client.listObjects('/', `${basePrefix}subdir1/`, undefined, {
      delimiter: '/',
    });
    expect(subdir1Result).toHaveLength(2);
    expect(subdir1Result.every(o => o.Key.startsWith(`${basePrefix}subdir1/`))).toBe(true);
    expect(subdir1Result.every(o => parseInt(String(o.Size)) > 0)).toBe(true); // all real files

    // Test deeper nesting
    const subdir2Result = await s3client.listObjects('/', `${basePrefix}subdir2/`, undefined, {
      delimiter: '/',
    });
    expect(subdir2Result).toHaveLength(1); // just the "deep/" prefix
    expect(subdir2Result[0].Key).toBe(`${basePrefix}subdir2/deep/`);
    expect(parseInt(String(subdir2Result[0].Size))).toBe(0);

    // Verify listObjectsPaged also returns CommonPrefixes with delimiter
    const { objects: pagedResult } = await s3client.listObjectsPaged('/', basePrefix, 100, undefined, {
      delimiter: '/',
    });
    expect(pagedResult).toHaveLength(4);
    const pagedFiles = pagedResult.filter(o => !o.Key.endsWith('/'));
    const pagedPrefixes = pagedResult.filter(o => o.Key.endsWith('/'));
    expect(pagedFiles).toHaveLength(2);
    expect(pagedPrefixes).toHaveLength(2);

    // Cleanup
    const all = await s3client.listObjects('/', basePrefix);
    await s3client.deleteObjects(all.map(o => o.Key));
    expect(await s3client.listObjects('/', basePrefix)).toEqual([]);
  });

  it('lists objects with spaces in prefix', async () => {
    const prefix = `test prefix with spaces ${Date.now()}/`;

    await s3client.putObject(`${prefix}file1.txt`, contentString);
    await s3client.putObject(`${prefix}file2.txt`, contentString);

    // This will fail with SignatureDoesNotMatch if space encoding mismatches
    const objects = await s3client.listObjects('/', prefix);

    expect(objects).toBeInstanceOf(Array);
    expect(objects).toHaveLength(2);

    await s3client.deleteObjects(objects.map(o => o.Key));
  });


  it('lists objects with pagination', async () => {
    /* ----- test data setup ----- */
    const prefix = `test-prefix-${Date.now()}/`; // isolate this run
    const totalKeys = 1_114;
    const pageSmall = 2;
    const pageLarge = 900;
    let counter = 0;
    let attempts = 0;
    let errors = [];

    // Bucket must start empty for this prefix
    expect(await s3client.listObjects('/', prefix)).toEqual([]);
    // Upload 1 114 objects in parallel
    const generator = function* (n) {
      for (let i = 0; i < n; i++)
        yield async () => {
          try {
            const response = await s3client.putObject(`${prefix}object${i}.txt`, contentString);
            attempts++;
            if (response.status === 200) {
              counter++;
            } else {
              throw new Error(`Unexpected status ${response.status}`);
            }
          } catch (err) {
            errors.push({ index: i, error: err.message || err });
            throw err; // Re-throw to let runInBatches handle it
          }
        };
    };
    const batchSize = providerName === 'backblaze' ? 20 : OP_CAP;
    await runInBatches(generator(totalKeys), batchSize, 1_000);

    // Retry any failed uploads (allSettled may silently drop some)
    const uploaded = await s3client.listObjects('/', prefix);
    const missingCount = totalKeys - uploaded.length;

    if (missingCount > 0) {
      const uploadedKeys = new Set(uploaded.map(o => o.Key));
      for (let i = 0; i < totalKeys; i++) {
        const key = `${prefix}object${i}.txt`;
        if (!uploadedKeys.has(key)) {
          await s3client.putObject(key, contentString);
          counter++;
        }
      }
    }
    /* ----- assertions ----- */
    // 1️⃣  Small page (2)
    const firstTwo = await s3client.listObjects('/', prefix, pageSmall);
    expect(firstTwo).toBeInstanceOf(Array);
    expect(firstTwo).toHaveLength(pageSmall); // ✔ array length = 2:contentReference[oaicite:1]{index=1}

    // 2️⃣  “Maximum” single page (1 000)
    const first900Hundred = await s3client.listObjects('/', prefix, pageLarge);
    expect(first900Hundred).toBeInstanceOf(Array);
    expect(first900Hundred).toHaveLength(pageLarge); // ✔ array length = 900:contentReference[oaicite:2]{index=2}
    expect(first900Hundred[0].Key).toBe(`${prefix}object0.txt`); // ✔ first object key
    await new Promise(resolve => setTimeout(resolve, 2000));
    // 3️⃣  Unlimited (implicit pagination inside helper)
    let everything = await s3client.listObjects('/', prefix); // maxKeys = undefined ⇒ list all
    expect(everything).toBeInstanceOf(Array);
    expect(everything).toHaveLength(counter);

    // 1️⃣ 1000 page - empty next token (explicit pagination - to return first page)
    let firstPage = await s3client.listObjectsPaged('/', prefix, 1_000, undefined); // nextContinuationToken = undefined ⇒ first page
    expect(firstPage.objects).toBeInstanceOf(Array);
    expect(firstPage.objects).toHaveLength(1_000);

    // 1️⃣ rest of the objects - with token (explicit pagination - continue from previous page)
    let secondPage = await s3client.listObjectsPaged('/', prefix, 1_000, firstPage.nextContinuationToken); // nextContinuationToken = continue from previous page
    expect(secondPage.objects).toBeInstanceOf(Array);
    expect(secondPage.objects).toHaveLength(totalKeys - 1_000);

    // cleanup and test deleteObjects
    for (let i = 0; i < 3; i++) {
      everything = await s3client.listObjects('/', prefix);
      if (everything.length === totalKeys) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    expect(everything.length).toBe(totalKeys);
    const massDelete = await s3client.deleteObjects(everything.map(o => o.Key));

    // Check if all deletions were successful
    const allDeleted = massDelete.every(result => result === true);
    expect(massDelete).toBeInstanceOf(Array);
    expect(massDelete.length).toBe(everything.length);
    expect(allDeleted).toBe(true);

    // Verify bucket now empty for this prefix
    expect(await s3client.listObjects('/', prefix)).toEqual([]);
  });

  it('listObjects returns correct types for Size (number) and LastModified (Date)', async () => {
    const prefix = `type-check-${Date.now()}/`;
    const content = 'type check content';

    await s3client.putObject(`${prefix}file.txt`, content, 'text/plain');

    const objects = await s3client.listObjects('/', prefix);
    expect(objects).toBeInstanceOf(Array);
    expect(objects).toHaveLength(1);

    const obj = objects[0];

    // Size must be a real number, not a string
    expect(typeof obj.Size).toBe('number');
    expect(obj.Size).toBe(byteSize(content));

    // LastModified must be a Date instance, not a string
    expect(obj.LastModified).toBeInstanceOf(Date);
    expect(obj.LastModified.getTime()).not.toBeNaN();
    // Should be recent (within last 60 seconds)
    expect(Date.now() - obj.LastModified.getTime()).toBeLessThan(60_000);

    // ETag should be a non-empty string
    expect(typeof obj.ETag).toBe('string');
    expect(obj.ETag.length).toBeGreaterThan(0);

    // Cleanup
    await s3client.deleteObjects([`${prefix}file.txt`]);
  });

};
