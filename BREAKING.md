# Breaking Changes

This is a comprehensive list of the breaking changes introduced in the major version releases of s3mini library.

## Versions

- [Version v0.8.1](#version-081)
- [Version v0.4.0](#version-040)
- [Version v0.3.0](#version-030)

## Next

- ESM only package, no more minified CJS build

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
