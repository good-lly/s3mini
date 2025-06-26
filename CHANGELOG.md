# Changelog

## [0.4.0] - soon

### Changed

- Renamed `s3mini` class to `S3mini` to follow TypeScript naming conventions.
- `s3mini` is now an alias for `S3mini` with deprecated usage flag.

## [0.3.0] - 2023-10-15

### Changed

- Response objects now use uppercase property names to match AWS S3 API conventions (except for `etag` which remains lowercase)
- `key` → `Key`
- `size` → `Size`
- `lastModified` → `LastModified`
- `etag` remains `etag`
