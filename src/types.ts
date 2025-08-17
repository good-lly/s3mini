export interface S3Config {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  region?: string;
  requestSizeInBytes?: number;
  requestAbortTimeout?: number;
  logger?: Logger;
}

export interface SSECHeaders {
  'x-amz-server-side-encryption-customer-algorithm': string;
  'x-amz-server-side-encryption-customer-key': string;
  'x-amz-server-side-encryption-customer-key-md5': string;
}

export interface AWSHeaders {
  [k: `x-amz-${string}`]: string;
}

export interface Crypto {
  createHmac: (
    algorithm: string,
    key: Buffer | string,
  ) => {
    update: (data: Buffer | string) => { digest: (encoding?: string) => string | Buffer };
    digest: (encoding?: string) => string | Buffer;
  };
  createHash: (algorithm: string) => {
    update: (data: Buffer | string) => { digest: (encoding?: string) => string | Buffer };
    digest: (encoding?: string) => string | Buffer;
  };
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
interface ListBucketError {
  error: { code: string; message: string };
}

export type ListBucketResponse = { listBucketResult: ListBucketResult } | { error: ListBucketError };

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
