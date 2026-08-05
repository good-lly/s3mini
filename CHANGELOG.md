# Changelog

## [1.0.0] - 2026-07-28

### Added

- Object versioning support (issue #3):
  - `setBucketVersioning` / `getBucketVersioning` (Put/GetBucketVersioning).
  - `listObjects` / `listObjectsPaged` accept `{ versions: true }` and parse `ListVersionsResult` (`Version` + `DeleteMarker` entries with optional `VersionId`, `IsLatest`, `IsDeleteMarker`).
  - New `listObjectVersions(key)` returns all versions for a specific object key (exact match), including which entry is latest.
  - `copyObject` accepts optional `versionId` on `CopyObjectOptions` (appended to `x-amz-copy-source`) for restore-by-copy.
  - `deleteObject` / `deleteObjects` accept `DeleteObject` (`{ key, versionId? }`) in addition to string keys; bulk delete XML includes `<VersionId>` when set.
  - `deleteObject` / `deleteObjects` accept `{ versionInfo: true }` to return a `DeleteObjectResult` / `DeleteObjectResult[]` carrying the deleted `versionId`, `deleteMarker`, and new `deleteMarkerVersionId` — read from the response headers/body so no follow-up list request is needed. Default boolean return is unchanged.
  - `copyObject` result now includes the new object's `versionId` (from the `x-amz-version-id` response header) on versioned buckets.
- Exported types: `ListObject`, `DeleteObject`, `DeleteObjectResult`, `CopyObjectOptions`, `CopyObjectResult`.
- E2E: real versioning lifecycle test (enable bucket → multi-put → list/get/copy-restore → versioned delete) against live providers; MinIO global setup enables versioning.
- `tests/bun-native.test.js` (`npm run test:bun-native`): checks that the native client is engaged
  only when it should be, that its reads, listings and deletes match the signed path, and that the
  list cursor advances or fails loudly.

### Changed

- ESM only package, no more minified CJS build.
- Bun is detected with `process.versions.bun` plus a `Bun.S3Client` capability check. The previous
  check compared `navigator.userAgent` to `'Bun'` while Bun reports `Bun/<version>`, so the fast
  paths added in 0.9.4 never ran. They do now — see [BREAKING.md](BREAKING.md) for what that changes.
- The native client is skipped when the caller supplies a custom `fetch` (its transport would be
  bypassed) or when credentials are empty (anonymous access to public buckets).
- Errors from native operations are re-thrown as `S3ServiceError`, with the HTTP status recovered
  from the error code where the S3 API pins it, so both runtimes throw the same shape.
- `putObject`, `putAnyObject`, `getObjectRaw` and `getObjectWithETag` have no Bun fast path. They
  were listed in 0.9.4 but never active, and each was wrong or slower than one signed request: Bun's
  `write()` rewrites `text/plain` to `text/plain;charset=utf-8`, stores a `ReadableStream` as the
  string `[object ReadableStream]` and never switches to multipart, while the two read helpers cost
  an extra round trip and `getObjectRaw` buffered the whole body instead of streaming it.
- Dropped the `extractBaseEndpoint` utility added in 0.9.4. The Bun client is configured with the
  endpoint origin plus `virtualHostedStyle` instead.
- `retryFetch` in the E2E harness also retries HTTP 500/502/503/504 (replayable bodies only), which
  the S3 API defines as transient. Backblaze returns `InternalError` often enough to fail a run.
- Under Bun the harness installs `retryFetch` as `globalThis.fetch` rather than passing it in the
  config, where it would have kept the whole run on the signed path and out of the native client.

### Fixed

- Bun `listObjects` paginated with `startAfter` derived from the last key, which stalled on a page
  holding only `CommonPrefixes`. It now follows `continuationToken`, and throws instead of looping
  forever when a truncated page repeats or omits the token.
- Bun `listObjects` returned empty `ETag`s (Bun spells the field `eTag`) and forced a `/` delimiter,
  grouping results the signed path returns flat.
- Bun clients for virtual-hosted endpoints signed `bucket.host/bucket/key`.
- Anonymous (credential-less) clients threw `ERR_S3_MISSING_CREDENTIALS` under Bun.

## [0.9.4] - 2026-04-08

### Added

- Bun native S3 support via `Bun.S3Client` — automatic fast paths for `getObject`, `getObjectAsBytes`, `getObjectAsJson`, `getObjectWithETag`, `getObjectRaw` (incl. range requests via `slice()`), `putObject`, `putAnyObject`, `deleteObject`, `objectExists`, `getEtag`, `getContentLength`, `getPresignedUrl`, and `listObjects`. All operations transparently fall back to the standard HTTP path when Bun-specific conditions aren't met (e.g. SSE-C headers, extra opts).
- `isBun` runtime detection and `extractBaseEndpoint` utility for Bun S3 client initialization.
  - **Correction:** none of these Bun fast paths ever activated. `isBun` compared
    `navigator.userAgent` to `'Bun'`, which Bun never reports. Fixed in 1.0.0, where `putObject`,
    `putAnyObject`, `getObjectRaw` and `getObjectWithETag` were also dropped from the list.
- Bun test runner (`tests/run-bun.js`) with Docker lifecycle management for provider tests.
- CI workflow now runs E2E tests on both Node and Bun runtimes.
- `retryFetch` wrapper in E2E test infrastructure for transient network error resilience (ETIMEDOUT, ECONNRESET).

### Changed

- Rewrote `_extractBucketName()` — cleaner logic, correctly handles IP addresses, virtual-hosted and path-style URLs.
- Optimized E2E test suite from 54 to 43 tests per provider by removing redundant coverage and merging related tests.
- Moved all Bun native type definitions (`NativeS3Stat`, `NativeS3File`, `NativeS3ListObject`, `NativeS3ListResult`, `NativeS3Client`) from `S3.ts` to `types.ts`.
- Migrated test files from `@jest/globals` imports to framework-agnostic globals (compatible with both Jest and Bun test runner).

### Fixed

- Fixed paginated listing for large buckets.
- Fixed false positive parseXml regex ReDoS scanner report.

## [0.9.3] - 2026-04-03

### Fixed

- Presigned URLs now support signing additional HTTP headers via a new optional `headers` parameter in `getPresignedUrl()`. Previously, `X-Amz-SignedHeaders` was hardcoded to `host`, making it impossible to enforce headers like `Content-Type` on presigned PUT uploads.

### Added

- New `headers` parameter (5th, optional) on `getPresignedUrl(method, key, expiresIn, queryParams, headers)`. Signed headers are included in `X-Amz-SignedHeaders` and the canonical request per AWS SigV4 spec. The `host` header is always signed automatically. Fully backward-compatible — omitting `headers` preserves existing behavior.

## [0.4.0] - 2025-07-01

### Changed

- Renamed `s3mini` class to `S3mini` to follow TypeScript naming conventions.
- `s3mini` is now an alias for `S3mini` with deprecated usage flag.
- Updated all references in the codebase to use `S3mini` instead of `s3mini`.
- Fixed Minio health check and its docker image. (Thanks @ScArLeXiA)

### Added

- Added `ListObject` interface type for better type safety in list operations.
- Added `CHANGELOG.md` to track changes and `BREAKING.md` for breaking changes.
- Added SSE-C support for server-side encryption with customer-provided keys. (Tested on Cloudflare only!)

### Fixed

- Fixed `getEtag` method to properly handle conditional requests and return `null` when no ETag is present.

## [0.3.0] - 2025-06-22

### Changed

- Response objects now use uppercase property names to match AWS S3 API conventions (except for `etag` which remains lowercase)
- `key` → `Key`
- `size` → `Size`
- `lastModified` → `LastModified`
- `etag` remains `etag`

More: [https://codeberg.org/thinking_tools/s3mini/releases/tag/v0.3.0](https://codeberg.org/thinking_tools/s3mini/releases/tag/v0.3.0)
