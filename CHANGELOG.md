# Changelog

## [0.9.4] - 2026-04-08

### Added

- Bun native S3 support via `Bun.S3Client` — automatic fast paths for `getObject`, `getObjectAsBytes`, `getObjectAsJson`, `getObjectWithETag`, `getObjectRaw` (incl. range requests via `slice()`), `putObject`, `putAnyObject`, `deleteObject`, `objectExists`, `getEtag`, `getContentLength`, `getPresignedUrl`, and `listObjects`. All operations transparently fall back to the standard HTTP path when Bun-specific conditions aren't met (e.g. SSE-C headers, extra opts).
- `isBun` runtime detection and `extractBaseEndpoint` utility for Bun S3 client initialization.
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

More: [https://github.com/good-lly/s3mini/releases/tag/v0.3.0](https://github.com/good-lly/s3mini/releases/tag/v0.3.0)
