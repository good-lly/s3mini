'use strict';

import { S3mini, sanitizeETag, runInBatches } from '../dist/index.mjs';
import { randomBytes } from 'node:crypto';

const TRANSIENT_CODES = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET'];
const MAX_RETRIES = 2;
// 60s: Cloudflare R2's bulk DeleteObjects (up to 1000 keys/request) can exceed a tighter limit.
const PER_REQUEST_TIMEOUT_MS = 60_000;

// Statuses the S3 API defines as transient and expects the caller to retry. s3mini does not retry
// on its own, and Backblaze answers InternalError often enough to redden a run by itself.
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
// A stream body cannot be sent twice, so those requests are handed back as-is.
const replayableBody = body =>
  body == null || typeof body === 'string' || ArrayBuffer.isView(body) || body instanceof ArrayBuffer;

// Captured before the global is replaced below, otherwise the wrapper would call itself.
const baseFetch = globalThis.fetch.bind(globalThis);

const retryFetch = async (input, init) => {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startedAt = Date.now();
    try {
      const signal = init?.signal ?? AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS);
      const res = await baseFetch(input, { ...init, signal });
      if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_RETRIES || !replayableBody(init?.body)) return res;
      console.warn(`retrying ${init?.method ?? 'GET'} ${new URL(input).pathname} after HTTP ${res.status}`);
      await res.body?.cancel();
    } catch (err) {
      const code = err?.cause?.code ?? err?.code ?? '';
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const isTransient = isTimeout || TRANSIENT_CODES.some(c => code.includes(c));
      // A request that dies here surfaces at the top of whatever test was running, with nothing
      // saying which request it was — name it while we still have the method, path and clock.
      const url = new URL(input);
      console.warn(
        `[${providerName}] ${init?.method ?? 'GET'} ${url.pathname}${url.search} failed after ` +
          `${Date.now() - startedAt}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err?.name ?? err} ${code}`,
      );
      if (!isTransient || attempt === MAX_RETRIES) throw err;
    }
    await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
  }
};

// s3mini only takes Bun's native S3 path when the default fetch is in use, so handing retryFetch to
// the client would keep the whole run on the signed path. Installing it as the default keeps the
// native path engaged and still retries the operations that have no native fast path — multipart,
// copy and put — which is where Backblaze's 500s land.
const nativeBun = typeof globalThis.Bun?.S3Client === 'function';
if (nativeBun) globalThis.fetch = retryFetch;

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

let providerName;
const key = 'first-test-object.txt';
const contentString = 'Hello, world!';

const specialCharContentString = 'Hello, world! \uD83D\uDE00';
const specialCharContentBufferExtra = Buffer.from(specialCharContentString + ' extra', 'utf-8');
const specialCharKey = 'special-char key with spaces.txt';

// Deleting by key on a versioned bucket only adds a delete marker — the old versions stay in the
// bucket index and listObjects() stops showing them, so the rot is invisible. Used here for the
// prefixes this suite creates in bulk; the whole-bucket sweep lives in tests/setup.js, off jest's
// per-test clock.
const purgeVersions = async (s3client, prefix = '') => {
  let listed;
  try {
    listed = await s3client.listObjects('/', prefix, undefined, { versions: true });
  } catch (err) {
    // Providers without ListObjectVersions (R2 answers 501, garage has no versioning) have
    // nothing to purge — anything else is worth seeing in the log.
    console.warn(`[${providerName}] version purge skipped: ${err?.message || err}`);
    return;
  }
  const targets = (listed ?? [])
    .filter(o => o.VersionId && o.VersionId !== 'null')
    .map(o => ({ key: o.Key, versionId: o.VersionId }));
  if (targets.length > 0) {
    await s3client.deleteObjects(targets);
  }
};

// Not exported: testRunner registers this on the shared describe, so provider files calling it
// again only duplicate the wipe.
const resetBucketBeforeAll = s3client => {
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
    ...(nativeBun ? {} : { fetch: retryFetch }),
  });

  resetBucketBeforeAll(s3client);

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

    // A bucket that is not there lists as null, never as an empty array and never as the parent
    // bucket's contents. Bun's native client answered the latter for this endpoint shape until it
    // learned to decline one that reaches past the bucket, so this has to hold on both runtimes.
    expect(await nonExistentBucket.listObjects()).toBeNull();
    expect(await nonExistentBucket.getObject('any-key.txt')).toBeNull();
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

    // A prefix that matches nothing is an empty listing, not an error. (This used to pass
    // 'non-existent-prefix' as the *delimiter* — the first parameter — so the request was a GET on
    // a key of that name, and the null it asserted was the 404 path reached by accident.)
    const objectsWithPrefix = await s3client.listObjects('/', 'non-existent-prefix/');
    expect(objectsWithPrefix).toEqual([]);
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
      // rejects.toThrow, not try/catch: a bare catch block passes silently on the day these
      // stop throwing, which is exactly the regression worth catching.
      await expect(s3client.getObject(key, {}, wrongSsecHeaders)).rejects.toThrow('400 – InvalidArgument');
      await expect(s3client.getObject(key)).rejects.toThrow('400 – InvalidRequest');

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

  it('presigned URL: deep nested key with special characters', async () => {
    const presignedKey = 'presigned/deeply/nested/dir/structure/file with spaces.txt';
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
    expect(dataBuffer.length).toBe(large_buffer.length);
    expect(dataBuffer.equals(large_buffer)).toBe(true);

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
    const rangeExpected = large_buffer.subarray(rangeStart, rangeEnd);
    expect(rangeBuffer.length).toBe(rangeExpected.length);
    expect(rangeBuffer.equals(rangeExpected)).toBe(true);

    // Open-ended range: bytes=EIGHT_MB- (from 8MB to end)
    const openRangeStart = EIGHT_MB;
    const openRangeResponse = await s3client.getObjectRaw(multipartKey, false, openRangeStart, undefined);
    expect(openRangeResponse.ok).toBe(true);
    expect(openRangeResponse.status).toBe(206);
    const openRangeData = await openRangeResponse.arrayBuffer();
    const openRangeBuffer = Buffer.from(openRangeData);
    expect(openRangeBuffer.length).toBe(large_buffer.length - openRangeStart);
    expect(openRangeBuffer.equals(large_buffer.subarray(openRangeStart))).toBe(true);
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

  // Providers that do not implement S3 object versioning APIs:
  // - garage: no versioning at all
  // - cloudflare R2: emits x-amz-version-id on Put for S3 client compat, but
  //   ListObjectVersions / GetObject?versionId / PutBucketVersioning all return 501
  //   (confirmed against live R2; see Cloudflare S3 API compatibility docs).
  const versioningUnsupported = new Set(['garage', 'cloudflare']);
  (versioningUnsupported.has(providerName) ? it.skip : it)(
    'object versioning: full lifecycle against real bucket',
    async () => {
      const isNotImplemented = err => {
        const code = err?.code || err?.svcCode || '';
        const msg = String(err?.message || err || '');
        const status = err?.status ?? err?.statusCode;
        return (
          status === 501 ||
          code === 'NotImplemented' ||
          /501|NotImplemented/i.test(msg)
        );
      };
      const isRealVersionId = id => typeof id === 'string' && id.length > 0 && id !== 'null';

      // This test never enables versioning itself. S3 has no way to turn versioning back off (only
      // Suspended), so flipping a shared provider bucket here would make every later run accumulate
      // versions permanently. MinIO is enabled in tests/setup.js and always covers this path; other
      // providers only take part if their bucket is already versioned.
      let versioningStatus;
      try {
        versioningStatus = await s3client.getBucketVersioning();
      } catch (err) {
        if (!isNotImplemented(err)) {
          throw err;
        }
        versioningStatus = 'Off';
      }
      if (versioningStatus !== 'Enabled') {
        console.warn(
          `[${providerName}] SKIP versioning lifecycle: bucket versioning is '${versioningStatus}'. ` +
            `Enable it out-of-band on this bucket to opt in.`,
        );
        return;
      }

      const key = `versioning-test-${Date.now()}.txt`;
      const v1Body = 'version-one-body';
      const v2Body = 'version-two-body';

      const put1 = await s3client.putObject(key, v1Body, 'text/plain');
      expect(put1.status).toBe(200);
      const put2 = await s3client.putObject(key, v2Body, 'text/plain');
      expect(put2.status).toBe(200);

      const id1 = put1.headers.get('x-amz-version-id');
      const id2 = put2.headers.get('x-amz-version-id');

      if (!isRealVersionId(id1) || !isRealVersionId(id2) || id1 === id2) {
        try {
          await s3client.deleteObject(key);
        } catch {
          /* ignore */
        }
        throw new Error(
          `[${providerName}] Bucket is not versioned (put x-amz-version-id: ${id1}, ${id2}). ` +
            `Enable object versioning on this bucket (MinIO setup enables it automatically).`,
        );
      }

      // Prove versioning is real (not just compatibility headers like R2).
      // Get-by-versionId must return the older body before we exercise list/copy/delete.
      let oldByVersion;
      try {
        oldByVersion = await s3client.getObject(key, { versionId: id1 });
      } catch (err) {
        try {
          await s3client.deleteObject(key);
        } catch {
          /* ignore */
        }
        if (isNotImplemented(err)) {
          throw new Error(
            `[${providerName}] Returns x-amz-version-id on Put but GetObject?versionId is NotImplemented. ` +
              `Add this provider to versioningUnsupported (Cloudflare R2 is in that set).`,
          );
        }
        throw err;
      }
      expect(oldByVersion).toBe(v1Body);
      expect(await s3client.getObject(key, { versionId: id2 })).toBe(v2Body);
      expect(await s3client.getObject(key)).toBe(v2Body);

      // listObjectVersions for this exact key
      const versions = await s3client.listObjectVersions(key);
      expect(versions).not.toBeNull();
      expect(versions.length).toBeGreaterThanOrEqual(2);
      expect(versions.every(v => v.Key === key)).toBe(true);
      expect(versions.some(v => v.VersionId === id1)).toBe(true);
      expect(versions.some(v => v.VersionId === id2)).toBe(true);

      const latest = versions.find(v => v.IsLatest && !v.IsDeleteMarker);
      expect(latest).toBeDefined();
      // Latest should be the second put (id2) when IsLatest is populated
      if (latest.VersionId) {
        expect(latest.VersionId).toBe(id2);
      }

      // listObjects({ versions: true }) also surfaces version metadata
      const listed = await s3client.listObjects('/', key, undefined, { versions: true });
      expect(listed.filter(o => o.Key === key).length).toBeGreaterThanOrEqual(2);
      expect(listed.some(o => o.Key === key && o.VersionId === id1)).toBe(true);

      // restore older version by copy onto same key
      const copyResult = await s3client.copyObject(key, key, { versionId: id1 });
      expect(copyResult.etag).toBeDefined();
      // Ceph RGW creates the new version but sends no x-amz-version-id on CopyObject responses
      // (verified against ceph v17 RGW), so the id is only asserted where the provider reports it.
      // The restore itself is proven below: a new version exists and it serves the older body.
      if (copyResult.versionId !== undefined) {
        expect(isRealVersionId(copyResult.versionId)).toBe(true);
      }
      expect(await s3client.getObject(key)).toBe(v1Body);

      const afterRestore = await s3client.listObjectVersions(key);
      expect(afterRestore.length).toBeGreaterThan(versions.length);
      expect(afterRestore.find(v => v.IsLatest && !v.IsDeleteMarker)).toBeDefined();

      // permanently delete one non-latest version
      const toDelete = afterRestore.find(
        v => !v.IsLatest && !v.IsDeleteMarker && isRealVersionId(v.VersionId),
      );
      expect(toDelete).toBeDefined();
      const singleInfo = await s3client.deleteObject(
        { key, versionId: toDelete.VersionId },
        { versionInfo: true },
      );
      expect(singleInfo).toEqual({ key, deleted: true, versionId: toDelete.VersionId });

      const afterSingleDelete = await s3client.listObjectVersions(key);
      expect(
        afterSingleDelete.some(v => v.VersionId === toDelete.VersionId && !v.IsDeleteMarker),
      ).toBe(false);

      // plain delete on a versioned bucket creates a delete marker; versionInfo surfaces it
      const markerInfo = await s3client.deleteObject(key, { versionInfo: true });
      expect(markerInfo.deleted).toBe(true);
      expect(markerInfo.deleteMarker).toBe(true);
      expect(isRealVersionId(markerInfo.deleteMarkerVersionId)).toBe(true);

      // bulk-delete every remaining version (+ delete markers) by VersionId
      const remaining = await s3client.listObjectVersions(key);
      const versionedTargets = remaining
        .filter(v => isRealVersionId(v.VersionId))
        .map(v => ({ key: v.Key, versionId: v.VersionId }));
      expect(versionedTargets.length).toBeGreaterThan(0);
      const bulkResults = await s3client.deleteObjects(versionedTargets, { versionInfo: true });
      expect(bulkResults).toHaveLength(versionedTargets.length);
      expect(bulkResults.every(r => r.deleted)).toBe(true);

      const finalVersions = await s3client.listObjectVersions(key);
      const live = finalVersions.filter(v => !v.IsDeleteMarker);
      expect(live).toHaveLength(0);
    },
  );

  // Sized to what a live bucket can prove: it truncates at maxKeys, orders lexicographically and
  // honours a continuation token. The >1000-key paths — an unlimited listObjects() following the
  // server's own 1000-key cap, and deleteObjects splitting into 1000-key batches — are unreachable
  // below that cap and are covered offline in tests/list-pagination.test.js. Doing them here cost
  // 1 114 uploads + 1 114 deletes per provider per run, which on a versioned bucket is ~2 228 index
  // entries and pushed hetzner past this harness's per-request timeout.
  it('lists objects with pagination', async () => {
    /* ----- test data setup ----- */
    const prefix = `test-prefix-${Date.now()}/`; // isolate this run
    const totalKeys = 15;
    const pageSmall = 2;
    const pageLarge = 10;

    // Bucket must start empty for this prefix
    expect(await s3client.listObjects('/', prefix)).toEqual([]);

    const keys = Array.from({ length: totalKeys }, (_, i) => `${prefix}object${i}.txt`);
    const uploads = await runInBatches(
      keys.map(k => () => s3client.putObject(k, contentString)),
      5,
    );
    // runInBatches settles rather than rejects, so a failed upload would otherwise only surface
    // further down as a confusingly short listing.
    expect(uploads.filter(r => r.status === 'rejected').map(r => String(r.reason))).toEqual([]);

    /* ----- assertions ----- */
    // Listing is eventually consistent on some providers, so let the count settle first.
    let everything = [];
    for (let i = 0; i < 3; i++) {
      everything = await s3client.listObjects('/', prefix); // maxKeys = undefined ⇒ list all
      if (everything.length === totalKeys) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    expect(everything).toBeInstanceOf(Array);
    expect(everything).toHaveLength(totalKeys);

    // 1️⃣  Small page (2)
    const firstTwo = await s3client.listObjects('/', prefix, pageSmall);
    expect(firstTwo).toBeInstanceOf(Array);
    expect(firstTwo).toHaveLength(pageSmall);
    // maxKeys must return the lexicographically first keys, not an arbitrary slice
    // ('object1.txt' sorts before 'object10.txt' because '.' < '0').
    expect(firstTwo.map(o => o.Key)).toEqual([`${prefix}object0.txt`, `${prefix}object1.txt`]);

    // 2️⃣  Explicit pagination: a full page hands back a token …
    const firstPage = await s3client.listObjectsPaged('/', prefix, pageLarge, undefined);
    expect(firstPage.objects).toBeInstanceOf(Array);
    expect(firstPage.objects).toHaveLength(pageLarge);
    expect(firstPage.nextContinuationToken).toBeTruthy();

    // 3️⃣  … and that token resumes where the first page stopped, with no repeats and no gaps.
    const secondPage = await s3client.listObjectsPaged('/', prefix, pageLarge, firstPage.nextContinuationToken);
    expect(secondPage.objects).toBeInstanceOf(Array);
    expect(secondPage.objects).toHaveLength(totalKeys - pageLarge);
    const pagedKeys = [...firstPage.objects, ...secondPage.objects].map(o => o.Key);
    expect(pagedKeys.slice().sort()).toEqual(keys.slice().sort());

    // cleanup and test deleteObjects
    const massDelete = await s3client.deleteObjects(everything.map(o => o.Key));

    // Check if all deletions were successful
    const allDeleted = massDelete.every(result => result === true);
    expect(massDelete).toBeInstanceOf(Array);
    expect(massDelete.length).toBe(everything.length);
    expect(allDeleted).toBe(true);

    // Verify bucket now empty for this prefix
    expect(await s3client.listObjects('/', prefix)).toEqual([]);

    // Deleting by key on a versioned bucket only hides the versions — reclaim this prefix so the
    // debris does not survive the run.
    await purgeVersions(s3client, prefix);
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
