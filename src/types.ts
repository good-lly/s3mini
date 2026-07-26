export interface S3Config {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  region?: string;
  requestSizeInBytes?: number;
  requestAbortTimeout?: number;
  logger?: Logger;
  fetch?: typeof fetch;
  minPartSize?: number;
}

export type PartData = Uint8Array | Blob | ArrayBuffer;

export interface SSECHeaders {
  'x-amz-server-side-encryption-customer-algorithm': string;
  'x-amz-server-side-encryption-customer-key': string;
  'x-amz-server-side-encryption-customer-key-md5': string;
}

export interface AWSHeaders {
  [k: `x-amz-${string}`]: string;
}

export interface Logger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

export interface UploadPart {
  partNumber: number;
  etag: string;
}

export interface ListObject {
  Key: string;
  Size: number;
  LastModified: Date;
  ETag: string;
  StorageClass: string;
  /** Present when listing with `{ versions: true }` or via `listObjectVersions`. */
  VersionId?: string;
  /** Present when listing versions; true if this is the current version of the key. */
  IsLatest?: boolean;
  /** True when the entry is a delete marker from ListObjectVersions. */
  IsDeleteMarker?: boolean;
}

/**
 * Object identity for delete APIs. Use instead of a bare key string when
 * targeting a specific version on a versioned bucket.
 */
export interface DeleteObject {
  key: string;
  versionId?: string;
}

export interface CompleteMultipartUploadResult {
  location: string;
  bucket: string;
  key: string;
  etag: string;
  eTag: string; // for backward compatibility
  ETag: string; // for backward compatibility
}

interface ListBucketResult {
  keyCount: string;
  contents?: Array<Record<string, unknown>>;
}
export interface ListBucketError {
  error: {
    code: string;
    message: string;
  };
}

export type ListBucketResponse = { listBucketResult: ListBucketResult } | ListBucketError;

export interface ListMultipartUploadSuccess {
  listMultipartUploadsResult: {
    bucket: string;
    key: string;
    uploadId: string;
    size?: number;
    mtime?: Date;
    etag?: string;
    eTag?: string; // for backward compatibility
    parts: UploadPart[];
    isTruncated: boolean;
    uploads: UploadPart[];
  };
}

export interface MultipartUploadError {
  error: {
    code: string;
    message: string;
  };
}

export interface ErrorWithCode {
  code?: string;
  cause?: { code?: string };
}

export type ListMultipartUploadResponse = ListMultipartUploadSuccess | MultipartUploadError;

export type HttpMethod = 'POST' | 'GET' | 'HEAD' | 'PUT' | 'DELETE';

// false - Not found (404)
// true - Found (200)
// null - ETag mismatch (412)
export type ExistResponseCode = false | true | null;

export type XmlValue = string | XmlMap | boolean | number | null;
export interface XmlMap {
  [key: string]: XmlValue | XmlValue[]; // one or many children
  [key: number]: XmlValue | XmlValue[]; // allow numeric keys
}

export interface CopyObjectOptions {
  /**
   * Source object version to copy. Appended as `?versionId=` on `x-amz-copy-source`.
   * Useful for restoring an older version (copy version onto the same key).
   */
  versionId?: string;

  /**
   * Specifies whether the metadata is copied from the source object or replaced with metadata provided in the request.
   * Valid values: 'COPY' | 'REPLACE'
   * Default: 'COPY'
   */
  metadataDirective?: 'COPY' | 'REPLACE';

  /**
   * Metadata to be set on the destination object when metadataDirective is 'REPLACE'.
   * Keys can be provided with or without 'x-amz-meta-' prefix.
   */
  metadata?: Record<string, string>;
  contentType?: string;

  /**
   * Storage class for the destination object.
   * Valid values: 'STANDARD' | 'REDUCED_REDUNDANCY' | 'STANDARD_IA' | 'ONEZONE_IA' | 'INTELLIGENT_TIERING' | 'GLACIER' | 'DEEP_ARCHIVE' | 'GLACIER_IR'
   */
  storageClass?: string;

  /**
   * Specifies whether the object tag-set is copied from the source object or replaced with tag-set provided in the request.
   * Valid values: 'COPY' | 'REPLACE'
   */
  taggingDirective?: 'COPY' | 'REPLACE';

  /**
   * If the bucket is configured as a website, redirects requests for this object to another object or URL.
   */
  websiteRedirectLocation?: string;

  /**
   * Server-Side Encryption with Customer-Provided Keys headers for the source object.
   * Should include:
   * - x-amz-copy-source-server-side-encryption-customer-algorithm
   * - x-amz-copy-source-server-side-encryption-customer-key
   * - x-amz-copy-source-server-side-encryption-customer-key-MD5
   */
  sourceSSECHeaders?: Record<string, string | number>;
  destinationSSECHeaders?: SSECHeaders;
  additionalHeaders?: Record<string, string | number>;
}

export interface CopyObjectResult {
  etag: string;
  lastModified?: Date;
}

type BinaryData = ArrayBuffer | Uint8Array;

type MaybeBuffer = typeof globalThis extends { Buffer?: infer B }
  ? B extends new (...a: unknown[]) => unknown
    ? InstanceType<B> | BinaryData
    : BinaryData
  : BinaryData;

export type DataInput = string | MaybeBuffer | ReadableStream | File | Blob;

// Bun-native S3 interfaces (zero-cost in non-Bun runtimes)
export interface NativeS3Stat {
  size: number;
  etag: string;
  lastModified: Date;
  type: string;
}

export interface NativeS3File {
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  stream(): ReadableStream;
  slice(start?: number, end?: number): NativeS3File;
  write(data: string | ArrayBuffer | Uint8Array | Blob | ReadableStream, opts?: { type?: string }): Promise<number>;
  writer(opts?: { type?: string }): { write(data: unknown): void; flush(): Promise<void>; end(): Promise<void> };
  delete(): Promise<void>;
  unlink(): Promise<void>;
  exists(): Promise<boolean>;
  stat(): Promise<NativeS3Stat>;
  presign(opts?: { method?: string; expiresIn?: number; acl?: string; type?: string }): string;
}

export interface NativeS3ListObject {
  key: string;
  lastModified: Date | string;
  size: number;
  /** Bun spells it `eTag` and leaves the XML entities (`&#34;`) unresolved. */
  eTag?: string;
  storageClass?: string;
}

export interface NativeS3ListResult {
  contents?: NativeS3ListObject[];
  commonPrefixes?: { prefix: string }[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

export interface NativeS3Client {
  file(key: string): NativeS3File;
  write(
    key: string,
    data: string | ArrayBuffer | Uint8Array | Blob | ReadableStream,
    opts?: Record<string, unknown>,
  ): Promise<number>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number>;
  stat(key: string): Promise<NativeS3Stat>;
  presign(key: string, opts?: { method?: string; expiresIn?: number; acl?: string; type?: string }): string;
  list(opts?: Record<string, unknown> | null, credentials?: Record<string, unknown>): Promise<NativeS3ListResult>;
}
