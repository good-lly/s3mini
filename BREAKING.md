# Breaking Changes

This is a comprehensive list of the breaking changes introduced in the major version releases of s3mini library.

## Versions
- [Verison v1.0.0](#version-100)
- [Version v0.8.1](#version-081)
- [Version v0.4.0](#version-040)
- [Version v0.3.0](#version-030)

## Version 1.0.0

- ESM only package, no more minified CJS build

- **The Bun native fast paths actually run now.** Runtime detection compared `navigator.userAgent` to
  `'Bun'`, but Bun reports `Bun/<version>`, so the paths added in 0.9.4 never engaged and everything
  went through signed `fetch`. On Bun, `getObject`, `getObjectArrayBuffer`, `getObjectJSON`,
  `getEtag`, `getContentLength`, `objectExists`, `deleteObject`, `listObjects` and
  `getPresignedUrl` are now served by `Bun.S3Client`. Node behaviour is unchanged. What differs on
  Bun:
  - Those requests no longer pass through `globalThis.fetch`, so fetch mocks and interceptors do not
    see them, `requestAbortTimeout` does not apply to them, and they produce no per-request `logger`
    output.
  - Errors are still `S3ServiceError` with the same `.code`, but `.status` is `0` for codes the S3
    API does not pin to a single status, and `.body` carries the provider's message text instead of
    the raw XML error body.
  - Presigned URLs are produced by Bun's signer. Valid SigV4, but the query parameters may differ.
  - **Migration**: passing any `fetch` in the config keeps the previous path, since a caller-supplied
    transport is never bypassed:

```typescript
const s3 = new S3mini({ ...config, fetch: (input, init) => fetch(input, init) });
```

- `putObject`, `putAnyObject`, `getObjectRaw` and `getObjectWithETag` no longer have Bun fast paths
  (listed in 0.9.4, never active). Bun's `write()` rewrites `text/plain` to `text/plain;charset=utf-8`,
  stores a `ReadableStream` as the literal string `[object ReadableStream]` and does not switch to
  multipart, while the two read helpers cost an extra round trip and `getObjectRaw` buffered the whole
  body instead of streaming it. All four use the signed path on every runtime.

## Version 0.8.1

- `listObjects` and `listObjectsPaged` now include `CommonPrefixes` in results when using the `delimiter` option
  - Directory prefixes are returned as synthetic `ListObject` entries with:
    - `Key` ending in `/` (e.g., `prefix/subdir/`)
    - `Size: 0`
    - `ETag: ''`
    - `StorageClass: ''`
    - `LastModified: new Date(0)`
  - **Migration**: If your code assumes all returned objects are files, filter by `!obj.Key.endsWith('/')` or check for non-empty `ETag`

```typescript
// Before: only files returned
const objects = await s3.listObjects('/', 'prefix/', undefined, { delimiter: '/' });

// After: files + directory prefixes returned
const all = await s3.listObjects('/', 'prefix/', undefined, { delimiter: '/' });
const files = all.filter(o => !o.Key.endsWith('/'));
const directories = all.filter(o => o.Key.endsWith('/'));
```

## Version 0.4.0

- The `s3mini` class has been renamed to `S3mini` to follow typescript naming conventions. `s3mini` is now an alias for `S3mini` with deprecated usage flag.

## Version 0.3.0

- Response objects now use uppercase property names to match AWS S3 API conventions (except for `etag` which remains lowercase)
  - `key` → `Key`
  - `size` → `Size`
  - `lastModified` → `LastModified`
    - `etag` remains `etag`
