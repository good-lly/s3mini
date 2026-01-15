# s3mini | Tiny & fast S3 client for node and edge platforms.

`s3mini` is an ultra-lightweight Typescript client (~20 KB minified, ≈15 % more ops/s) for S3-compatible object storage. It runs on Node, Bun, Cloudflare Workers, and other edge platforms. It has been tested on Cloudflare R2, Backblaze B2, DigitalOcean Spaces, Ceph, Oracle, Garage and MinIO. (No Browser support!)

[[github](https://github.com/good-lly/s3mini)]
[[issues](https://github.com/good-lly/s3mini/issues)]
[[npm](https://www.npmjs.com/package/s3mini)]

## Features

- 🚀 Light and fast: averages ≈15 % more ops/s and only ~20 KB (minified, not gzipped).
- 🔧 Zero dependencies; supports AWS SigV4 (no pre-signed requests) and SSE-C headers (tested on Cloudflare)
- 🟠 Works on Cloudflare Workers; ideal for edge computing, Node, and Bun (no browser support).
- 🔑 Only the essential S3 APIs—improved list, put, get, delete, and a few more.
- 🛠️ Supports multipart uploads.
- 🎄 Tree-shakeable ES module.
- 🎯 TypeScript support with type definitions.
- 📚 Documented with examples, tests and widely tested on various S3-compatible services! (Contributions welcome!)
- 📦 **BYOS3** — _Bring your own S3-compatible bucket_ (tested on Cloudflare R2, Backblaze B2, DigitalOcean Spaces, MinIO, Garage, Micro/Ceph and Oracle Object Storage, Scaleway).

#### Tested On

![Tested On](testedon.png) and more ...
Contributions welcome!

Dev:

[![GitHub commit activity (branch)](https://img.shields.io/github/commit-activity/m/good-lly/s3mini/dev?color=green)](https://github.com/good-lly/s3mini/commits/dev)
[![GitHub Issues or Pull Requests](https://img.shields.io/github/issues/good-lly/s3mini)](https://github.com/good-lly/s3mini/issues)
[![CodeQL Advanced](https://github.com/good-lly/s3mini/actions/workflows/codeql.yml/badge.svg?branch=dev)](https://github.com/good-lly/s3mini/actions/workflows/codeql.yml)
[![Bugs](https://sonarcloud.io/api/project_badges/measure?project=good-lly_s3mini&metric=bugs)](https://sonarcloud.io/summary/new_code?id=good-lly_s3mini)
[![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=good-lly_s3mini&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=good-lly_s3mini)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=good-lly_s3mini&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=good-lly_s3mini)
[![Vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=good-lly_s3mini&metric=vulnerabilities)](https://sonarcloud.io/summary/new_code?id=good-lly_s3mini)
[![Technical Debt](https://sonarcloud.io/api/project_badges/measure?project=good-lly_s3mini&metric=sqale_index)](https://sonarcloud.io/summary/new_code?id=good-lly_s3mini)
[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=good-lly_s3mini&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=good-lly_s3mini)
[![Test:e2e(all)](https://github.com/good-lly/s3mini/actions/workflows/test-e2e.yml/badge.svg?branch=dev)](https://github.com/good-lly/s3mini/actions/workflows/test-e2e.yml)

![GitHub Repo stars](https://img.shields.io/github/stars/good-lly/s3mini?style=social)
[![NPM Downloads](https://img.shields.io/npm/dm/s3mini)](https://www.npmjs.com/package/s3mini)
![NPM Version](https://img.shields.io/npm/v/s3mini?color=green)
![npm package minimized gzipped size](https://img.shields.io/bundlejs/size/s3mini?color=green)
![GitHub License](https://img.shields.io/github/license/good-lly/s3mini)

<a href="https://github.com/good-lly/s3mini/issues/"> <img src="https://img.shields.io/badge/contributions-welcome-brightgreen.svg" alt="Contributions welcome" /></a>

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Uploading Objects](#uploading-objects)
- [Downloading Objects](#downloading-objects)
- [Listing Objects](#listing-objects)
- [Deleting Objects](#deleting-objects)
- [Copy and Move](#copy-and-move)
- [Conditional Requests](#conditional-requests)
- [Server-Side Encryption (SSE-C)](#server-side-encryption-sse-c)
- [API Reference](#api-reference)
- [Error Handling](#error-handling)
- [Cloudflare Workers](#cloudflare-workers)
- [Supported Operations](#supported-operations)
- [Security Notes](#security-notes)
- [💙 Contributions welcomed!](#contributions-welcomed)
- [License](#license)

## Installation

```bash
npm install s3mini
```

```bash
yarn add s3mini
```

```bash
pnpm add s3mini
```

### Environment Variables

To use `s3mini`, you need to set up your environment variables for provider credentials and S3 endpoint. Create a `.env` file in your project root directory. Checkout the [example.env](example.env) file for reference.

```bash
# On Windows, Mac, or Linux
mv example.env .env
```

> **⚠️ Environment Support Notice**
>
> This library is designed to run in environments like **Node.js**, **Bun**, and **Cloudflare Workers**. It does **not support browser environments** due to the use of Node.js APIs and polyfills.

## Quick Start

```typescript
import { S3mini } from 's3mini';

const s3 = new S3mini({
  accessKeyId: process.env.S3_ACCESS_KEY,
  secretAccessKey: process.env.S3_SECRET_KEY,
  endpoint: 'https://bucket.region.r2.cloudflarestorage.com',
  region: 'auto',
});

// Upload (auto-selects single PUT or multipart based on size)
await s3.putAnyObject('photos/vacation.jpg', fileBuffer, 'image/jpeg');

// Download
const data = await s3.getObject('photos/vacation.jpg');

// List
const objects = await s3.listObjects('/', 'photos/');

// Delete
await s3.deleteObject('photos/vacation.jpg');
```

## Configuration

```typescript
const s3 = new S3mini({
  // Required
  accessKeyId: string,
  secretAccessKey: string,
  endpoint: string, // Full URL: https://bucket.region.provider.com

  // Optional
  region: string, // Default: 'auto'
  minPartSize: number, // Default: 8MB — threshold for multipart
  requestSizeInBytes: number, // Default: 8MB — chunk size for range requests
  requestAbortTimeout: number, // Timeout in ms (undefined = no timeout)
  logger: Logger, // Custom logger with info/warn/error methods
  fetch: typeof fetch, // Custom fetch implementation
});
```

**Endpoint formats:**

```typescript
// Path-style (bucket in path)
'https://s3.us-east-1.amazonaws.com/my-bucket';

// Virtual-hosted-style (bucket in subdomain)
'https://my-bucket.s3.us-east-1.amazonaws.com';

// Provider-specific
'https://my-bucket.nyc3.digitaloceanspaces.com';
'https://account-id.r2.cloudflarestorage.com/my-bucket';
```

---

## Uploading Objects

### putObject — Simple Upload

Direct single-request upload. Use for small files or when you need fine control.

```typescript
const response = await s3.putObject(
  key: string,                    // Object key/path
  data: string | Buffer | Uint8Array | Blob | File | ReadableStream,
  contentType?: string,           // Default: 'application/octet-stream'
  ssecHeaders?: SSECHeaders,      // Optional encryption headers
  additionalHeaders?: AWSHeaders, // Optional x-amz-* headers
  contentLength?: number,         // Optional, auto-detected for most types
);

// Returns: Response object
const etag = response.headers.get('etag');
```

**Examples:**

```typescript
// String content
await s3.putObject('config.json', JSON.stringify({ key: 'value' }), 'application/json');

// Buffer/Uint8Array
const buffer = await fs.readFile('image.png');
await s3.putObject('images/photo.png', buffer, 'image/png');

// Blob (browser File API or Node 18+)
const blob = new Blob(['Hello'], { type: 'text/plain' });
await s3.putObject('hello.txt', blob, 'text/plain');

// With custom headers
await s3.putObject('data.bin', buffer, 'application/octet-stream', undefined, {
  'x-amz-meta-author': 'john',
  'x-amz-meta-version': '1.0',
});
```

### putAnyObject — Smart Upload (Recommended)

Automatically chooses single PUT or multipart based on data size. **This is the recommended method for most use cases.**

```typescript
const response = await s3.putAnyObject(
  key: string,
  data: string | Buffer | Uint8Array | Blob | File | ReadableStream,
  contentType?: string,
  ssecHeaders?: SSECHeaders,
  additionalHeaders?: AWSHeaders,
  contentLength?: number,
);
```

**Behavior:**

- **≤ minPartSize (8MB default):** Single PUT request
- **> minPartSize:** Automatic multipart upload with:
  - Parallel part uploads (4 concurrent by default)
  - Automatic retries with exponential backoff (3 retries)
  - Proper cleanup on failure (aborts incomplete uploads)

**Examples:**

```typescript
// Small file — uses single PUT internally
await s3.putAnyObject('small.txt', 'Hello World');

// Large file — automatically uses multipart
const largeBuffer = await fs.readFile('video.mp4'); // 500MB
await s3.putAnyObject('videos/movie.mp4', largeBuffer, 'video/mp4');

// Blob (zero-copy slicing for memory efficiency)
const file = new File([largeArrayBuffer], 'data.bin');
await s3.putAnyObject('uploads/data.bin', file);

// ReadableStream (uploads as data arrives)
const stream = fs.createReadStream('huge-file.dat');
await s3.putAnyObject('backups/data.dat', Readable.toWeb(stream));
```

**Memory efficiency with Blobs:**

For large files, using `Blob` or `File` is more memory-efficient than `Uint8Array`:

```typescript
// ❌ Loads entire file into memory
const buffer = await fs.readFile('large-video.mp4');
await s3.putAnyObject('video.mp4', buffer);

// ✅ Zero-copy slicing — only reads data when uploading each part
const file = Bun.file('large-video.mp4'); // Bun
// or
const blob = new Blob([await fs.readFile('large-video.mp4')]); // Node
await s3.putAnyObject('video.mp4', file);
```

### Manual Multipart Upload

For advanced control over multipart uploads (progress tracking, resumable uploads, custom concurrency).

```typescript
// 1. Initialize upload
const uploadId = await s3.getMultipartUploadId(
  key: string,
  contentType?: string,
  ssecHeaders?: SSECHeaders,
  additionalHeaders?: AWSHeaders,
);

// 2. Upload parts (must be ≥ 5MB except last part)
const parts: UploadPart[] = [];

for (let i = 0; i < totalParts; i++) {
  const partData = buffer.subarray(i * partSize, (i + 1) * partSize);
  const part = await s3.uploadPart(
    key,
    uploadId,
    partData,
    i + 1,  // partNumber: 1-indexed, max 10,000
  );
  parts.push(part);
  console.log(`Uploaded part ${i + 1}/${totalParts}`);
}

// 3. Complete upload
const result = await s3.completeMultipartUpload(key, uploadId, parts);
console.log('Final ETag:', result.etag);
```

**Parallel uploads with progress:**

```typescript
import { runInBatches } from 's3mini';

const PART_SIZE = 8 * 1024 * 1024; // 8MB
const CONCURRENCY = 6;

async function uploadWithProgress(key: string, data: Uint8Array) {
  const uploadId = await s3.getMultipartUploadId(key);
  const totalParts = Math.ceil(data.byteLength / PART_SIZE);
  let completed = 0;

  const tasks = Array.from({ length: totalParts }, (_, i) => async () => {
    const start = i * PART_SIZE;
    const end = Math.min(start + PART_SIZE, data.byteLength);
    const part = await s3.uploadPart(key, uploadId, data.subarray(start, end), i + 1);
    completed++;
    console.log(`Progress: ${((completed / totalParts) * 100).toFixed(1)}%`);
    return part;
  });

  const results = await runInBatches(tasks, CONCURRENCY);
  const parts = results
    .filter((r): r is PromiseFulfilledResult => r.status === 'fulfilled')
    .map(r => r.value)
    .sort((a, b) => a.partNumber - b.partNumber);

  return s3.completeMultipartUpload(key, uploadId, parts);
}
```

**Abort an incomplete upload:**

```typescript
await s3.abortMultipartUpload(key, uploadId);
```

**List pending multipart uploads:**

```typescript
const pending = await s3.listMultipartUploads();
// Clean up orphaned uploads
for (const upload of pending.Upload || []) {
  await s3.abortMultipartUpload(upload.Key, upload.UploadId);
}
```

---

## Downloading Objects

```typescript
// As string
const text = await s3.getObject('file.txt');

// As ArrayBuffer
const buffer = await s3.getObjectArrayBuffer('image.png');

// As JSON (auto-parsed)
const data = await s3.getObjectJSON('config.json');

// Full Response object (for headers, streaming)
const response = await s3.getObjectResponse('video.mp4');
const stream = response.body; // ReadableStream

// With ETag for caching
const { etag, data } = await s3.getObjectWithETag('file.txt');

// Range request (partial download)
const response = await s3.getObjectRaw(
  'large-file.bin',
  false, // wholeFile: false for range request
  0, // rangeFrom
  1024 * 1024, // rangeTo (first 1MB)
);
```

---

## Listing Objects

```typescript
// List all objects (auto-paginates)
const objects = await s3.listObjects();

// With prefix filter (list "folder")
const photos = await s3.listObjects('/', 'photos/');

// With max keys limit
const first100 = await s3.listObjects('/', '', 100);

// Manual pagination
let token: string | undefined;
do {
  const { objects, nextContinuationToken } = await s3.listObjectsPaged(
    '/', // delimiter
    'uploads/', // prefix
    100, // maxKeys per page
    token, // continuation token
  );
  console.log(objects);
  token = nextContinuationToken;
} while (token);
```

**Response shape:**

```typescript
interface ListObject {
  Key: string;
  Size: number;
  LastModified: Date;
  ETag: string;
  StorageClass: string;
}
```

---

## Deleting Objects

```typescript
// Single object
const deleted = await s3.deleteObject('file.txt'); // boolean

// Multiple objects (batched, max 1000 per request)
const keys = ['a.txt', 'b.txt', 'c.txt'];
const results = await s3.deleteObjects(keys); // boolean[] in same order
```

---

## Copy and Move

Server-side copy (no data transfer through client):

```typescript
// Copy within same bucket
const result = await s3.copyObject('source.txt', 'backup/source.txt');

// Copy with new metadata
await s3.copyObject('report.pdf', 'archive/report.pdf', {
  metadataDirective: 'REPLACE',
  metadata: {
    'archived-at': new Date().toISOString(),
  },
  contentType: 'application/pdf',
});

// Move (copy + delete source)
await s3.moveObject('temp/upload.tmp', 'files/document.pdf');
```

**Options:**

```typescript
interface CopyObjectOptions {
  metadataDirective?: 'COPY' | 'REPLACE';
  metadata?: Record;
  contentType?: string;
  storageClass?: string;
  taggingDirective?: 'COPY' | 'REPLACE';
  sourceSSECHeaders?: SSECHeaders;
  destinationSSECHeaders?: SSECHeaders;
  additionalHeaders?: AWSHeaders;
}
```

---

## Conditional Requests

Use If-\* headers to avoid unnecessary transfers:

```typescript
// Only download if changed (returns null if ETag matches)
const data = await s3.getObject('file.txt', {
  'if-none-match': '"abc123"',
});

// Only download if modified since date
const data = await s3.getObject('file.txt', {
  'if-modified-since': 'Wed, 21 Oct 2024 07:28:00 GMT',
});

// Check existence with conditions
const exists = await s3.objectExists('file.txt', {
  'if-match': '"abc123"',
}); // null if ETag mismatch, true/false otherwise
```

---

## Server-Side Encryption (SSE-C)

Customer-provided encryption keys (tested on Cloudflare R2):

```typescript
const ssecHeaders = {
  'x-amz-server-side-encryption-customer-algorithm': 'AES256',
  'x-amz-server-side-encryption-customer-key': base64Key,
  'x-amz-server-side-encryption-customer-key-md5': base64KeyMd5,
};

// Upload encrypted
await s3.putObject('secret.dat', data, 'application/octet-stream', ssecHeaders);

// Download encrypted (must provide same key)
const decrypted = await s3.getObject('secret.dat', {}, ssecHeaders);

// Copy encrypted object
await s3.copyObject('secret.dat', 'backup/secret.dat', {
  sourceSSECHeaders: {
    'x-amz-copy-source-server-side-encryption-customer-algorithm': 'AES256',
    'x-amz-copy-source-server-side-encryption-customer-key': base64Key,
    'x-amz-copy-source-server-side-encryption-customer-key-md5': base64KeyMd5,
  },
  destinationSSECHeaders: ssecHeaders,
});
```

---

## API Reference

### Constructor

| Parameter             | Type           | Default            | Description               |
| --------------------- | -------------- | ------------------ | ------------------------- |
| `accessKeyId`         | `string`       | required           | AWS access key            |
| `secretAccessKey`     | `string`       | required           | AWS secret key            |
| `endpoint`            | `string`       | required           | Full S3 endpoint URL      |
| `region`              | `string`       | `'auto'`           | AWS region                |
| `minPartSize`         | `number`       | `8388608`          | Multipart threshold (8MB) |
| `requestAbortTimeout` | `number`       | `undefined`        | Request timeout in ms     |
| `logger`              | `Logger`       | `undefined`        | Custom logger             |
| `fetch`               | `typeof fetch` | `globalThis.fetch` | Custom fetch              |

### Methods

| Method                                                             | Returns                                     | Description             |
| ------------------------------------------------------------------ | ------------------------------------------- | ----------------------- |
| `bucketExists()`                                                   | `Promise<boolean>`                          | Check if bucket exists  |
| `createBucket()`                                                   | `Promise<boolean>`                          | Create bucket           |
| `listObjects(delimiter?, prefix?, maxKeys?)`                       | `Promise<ListObject[] \| null>`             | List all objects        |
| `listObjectsPaged(delimiter?, prefix?, maxKeys?, token?)`          | `Promise<{objects, nextContinuationToken}>` | Paginated list          |
| `getObject(key, opts?, ssec?)`                                     | `Promise<string \| null>`                   | Get object as string    |
| `getObjectArrayBuffer(key, opts?, ssec?)`                          | `Promise<ArrayBuffer \| null>`              | Get as ArrayBuffer      |
| `getObjectJSON<T>(key, opts?, ssec?)`                              | `Promise<T \| null>`                        | Get as parsed JSON      |
| `getObjectResponse(key, opts?, ssec?)`                             | `Promise<Response \| null>`                 | Get full Response       |
| `getObjectWithETag(key, opts?, ssec?)`                             | `Promise<{etag, data}>`                     | Get with ETag           |
| `getObjectRaw(key, wholeFile?, from?, to?, opts?, ssec?)`          | `Promise<Response>`                         | Range request           |
| `putObject(key, data, type?, ssec?, headers?, length?)`            | `Promise<Response>`                         | Simple upload           |
| `putAnyObject(key, data, type?, ssec?, headers?, length?)`         | `Promise<Response>`                         | Smart upload            |
| `deleteObject(key)`                                                | `Promise<boolean>`                          | Delete single object    |
| `deleteObjects(keys)`                                              | `Promise<boolean[]>`                        | Delete multiple         |
| `objectExists(key, opts?)`                                         | `Promise<boolean \| null>`                  | Check existence         |
| `getEtag(key, opts?, ssec?)`                                       | `Promise<string \| null>`                   | Get ETag only           |
| `getContentLength(key, ssec?)`                                     | `Promise<number>`                           | Get size in bytes       |
| `copyObject(source, dest, opts?)`                                  | `Promise<CopyObjectResult>`                 | Server-side copy        |
| `moveObject(source, dest, opts?)`                                  | `Promise<CopyObjectResult>`                 | Copy + delete           |
| `getMultipartUploadId(key, type?, ssec?, headers?)`                | `Promise<string>`                           | Init multipart          |
| `uploadPart(key, uploadId, data, partNum, opts?, ssec?, headers?)` | `Promise<UploadPart>`                       | Upload part             |
| `completeMultipartUpload(key, uploadId, parts)`                    | `Promise<CompleteResult>`                   | Complete multipart      |
| `abortMultipartUpload(key, uploadId, ssec?)`                       | `Promise<object>`                           | Abort multipart         |
| `listMultipartUploads(delimiter?, prefix?, method?, opts?)`        | `Promise<object>`                           | List pending            |
| `sanitizeETag(etag)`                                               | `string`                                    | Remove quotes from ETag |

### Utility Functions

```typescript
import { runInBatches, sanitizeETag } from 's3mini';

// Run async tasks with concurrency control
const results = await runInBatches(
  tasks: Iterable<() => Promise>,
  batchSize?: number,    // Default: 30
  minIntervalMs?: number // Default: 0 (no delay between batches)
);

// Clean ETag value
const clean = sanitizeETag('"abc123"'); // 'abc123'
```

---

## Error Handling

```typescript
import { S3ServiceError, S3NetworkError } from 's3mini';

try {
  await s3.getObject('missing.txt');
} catch (err) {
  if (err instanceof S3ServiceError) {
    console.error(`S3 error ${err.status}: ${err.serviceCode}`);
    console.error('Response body:', err.body);
  } else if (err instanceof S3NetworkError) {
    console.error(`Network error: ${err.code}`); // ENOTFOUND, ETIMEDOUT, etc.
  }
}
```

**Error classes:**

- `S3Error` — Base error class
- `S3ServiceError` — S3 returned an error response (4xx, 5xx)
- `S3NetworkError` — Network-level failure (DNS, timeout, connection refused)

---

## Cloudflare Workers

Works natively without `nodejs_compat`:

```typescript
export default {
  async fetch(request: Request, env: Env): Promise {
    const s3 = new S3mini({
      accessKeyId: env.R2_ACCESS_KEY,
      secretAccessKey: env.R2_SECRET_KEY,
      endpoint: env.R2_ENDPOINT,
    });

    const data = await s3.getObject('hello.txt');
    return new Response(data);
  },
};
```

---

## Supported Operations

| Operation               | Method                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| HeadBucket              | `bucketExists()`                                                                                                           |
| CreateBucket            | `createBucket()`                                                                                                           |
| ListObjectsV2           | `listObjects()`, `listObjectsPaged()`                                                                                      |
| GetObject               | `getObject()`, `getObjectArrayBuffer()`, `getObjectJSON()`, `getObjectResponse()`, `getObjectWithETag()`, `getObjectRaw()` |
| PutObject               | `putObject()`, `putAnyObject()`                                                                                            |
| DeleteObject            | `deleteObject()`                                                                                                           |
| DeleteObjects           | `deleteObjects()`                                                                                                          |
| HeadObject              | `objectExists()`, `getEtag()`, `getContentLength()`                                                                        |
| CopyObject              | `copyObject()`, `moveObject()`                                                                                             |
| CreateMultipartUpload   | `getMultipartUploadId()`                                                                                                   |
| UploadPart              | `uploadPart()`                                                                                                             |
| CompleteMultipartUpload | `completeMultipartUpload()`                                                                                                |
| AbortMultipartUpload    | `abortMultipartUpload()`                                                                                                   |
| ListMultipartUploads    | `listMultipartUploads()`                                                                                                   |

---

## Security Notes

- The library masks sensitive information (access keys, session tokens, etc.) when logging.
- Always protect your AWS credentials and avoid hard-coding them in your application (!!!). Use environment variables. Use environment variables or a secure vault for storing credentials.
- Ensure you have the necessary permissions to access the S3 bucket and perform operations.
- Be cautious when using multipart uploads, as they can incur additional costs if not managed properly.
- Authors are not responsible for any data loss or security breaches resulting from improper usage of the library.
- If you find a security vulnerability, please report it to us directly via email. For more details, please refer to the [SECURITY.md](SECURITY.md) file.

## Contributions welcomed! (in specific order)

Contributions are greatly appreciated! If you have an idea for a new feature or have found a bug, we encourage you to get involved in this order:

1. _Open/Report Issues or Ideas_: If you encounter a problem, have an idea or a feature request, please open an issue on GitHub (FIRST!) . Be concise but include as much detail as necessary (environment, error messages, logs, steps to reproduce, etc.) so we can understand and address the issue and have a dialog.

2. _Create Pull Requests_: We welcome PRs! If you want to implement a new feature or fix a bug, feel free to submit a pull request to the latest `dev branch`. For major changes, it's a necessary to discuss your plans in an issue first!

3. _Lightweight Philosophy_: When contributing, keep in mind that s3mini aims to remain lightweight and dependency-free. Please avoid adding heavy dependencies. New features should provide significant value to justify any increase in size.

4. _Community Conduct_: Be respectful and constructive in communications. We want a welcoming environment for all contributors. For more details, please refer to our [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). No one reads it, but it's there for a reason.

If you figure out a solution to your question or problem on your own, please consider posting the answer or closing the issue with an explanation. It could help the next person who runs into the same thing!

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.

## Sponsor This Project

Developing and maintaining s3mini (and other open-source projects) requires time and effort. If you find this library useful, please consider sponsoring its development. Your support helps ensure I can continue improving s3mini and other projects. Thank you!

[![Become a Sponsor](https://img.shields.io/badge/💸_GitHub-Sponsor-ff69b4?logo=github&logoColor=white)](https://github.com/sponsors/good-lly)
