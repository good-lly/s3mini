'use strict';

import type { DataInput, XmlValue, XmlMap, ListBucketResponse, ErrorWithCode, PartData } from './types.js';
import { ERROR_PREFIX } from './consts.js';

const ENCODR = new TextEncoder();
const chunkSize = 0x8000; // 32KB chunks
const HEX_CHARS = new Uint8Array([48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 97, 98, 99, 100, 101, 102]);

export const getByteSize = (data: DataInput): number => {
  if (typeof data === 'string') {
    return ENCODR.encode(data).byteLength;
  }
  if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
    return data.byteLength;
  }
  if (data instanceof Blob || data instanceof File) {
    return data.size;
  }
  if (data instanceof ReadableStream) {
    return Number.NaN; // size unknown
  }
  throw new Error('Unsupported data type');
};

export const toUint8Array = (data: DataInput): Uint8Array | null => {
  if (typeof data === 'string') {
    return ENCODR.encode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  // Node Buffer
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
};

/**
 * Turn a raw ArrayBuffer into its hexadecimal representation.
 * @param {ArrayBuffer} buffer The raw bytes.
 * @returns {string} Hexadecimal string
 */

export const hexFromBuffer = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  const hex = new Uint8Array(bytes.length * 2);
  for (let i = 0, j = 0; i < bytes.length; i++) {
    hex[j++] = HEX_CHARS[bytes[i]! >> 4]!;
    hex[j++] = HEX_CHARS[bytes[i]! & 0x0f]!;
  }
  return String.fromCodePoint(...hex);
};

/**
 * Turn a raw ArrayBuffer into its base64 representation.
 * @param {ArrayBuffer} buffer The raw bytes.
 * @returns {string} Base64 string
 */
export const base64FromBuffer = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let result = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    result += btoa(String.fromCodePoint(...chunk));
  }
  return result;
};

/**
 * Compute SHA-256 hash of arbitrary string data.
 * @param {string} content The content to be hashed.
 * @returns {ArrayBuffer} The raw hash
 */
export const sha256 = async (content: string): Promise<ArrayBuffer> => {
  const data = ENCODR.encode(content);

  return await globalThis.crypto.subtle.digest('SHA-256', data);
};

/**
 * Compute HMAC-SHA-256 of arbitrary data.
 * @param {string|ArrayBuffer} key The key used to sign the content.
 * @param {string} content The content to be signed.
 * @returns {ArrayBuffer} The raw signature
 */
export const hmac = async (key: string | ArrayBuffer, content: string): Promise<ArrayBuffer> => {
  const secret = await globalThis.crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? ENCODR.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const data = ENCODR.encode(content);

  return await globalThis.crypto.subtle.sign('HMAC', secret, data);
};

/**
 * Sanitize ETag value by removing quotes and XML entities
 * @param etag ETag value to sanitize
 * @returns Sanitized ETag
 */
export const sanitizeETag = (etag: string): string => {
  const replaceChars: Record<string, string> = {
    '"': '',
    '&quot;': '',
    '&#34;': '',
  };
  return etag.replaceAll(/(^("|&quot;|&#34;))|(("|&quot;|&#34;)$)/g, m => replaceChars[m] || '');
};

const entityMap = {
  '&quot;': '"',
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
} as const;

/**
 * Escape special characters for XML
 * @param value String to escape
 * @returns XML-escaped string
 */
export const escapeXml = (value: string): string => {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
};

const unescapeXml = (value: string): string =>
  value.replaceAll(/&(quot|apos|lt|gt|amp);/g, m => entityMap[m as keyof typeof entityMap] ?? m);

/**
 * Parse a very small subset of XML into a JS structure.
 *
 * @param input raw XML string
 * @returns string for leaf nodes, otherwise a map of children
 */

export const parseXml = (input: string): XmlValue => {
  const xmlContent = input.replace(/<\?xml[^?]*\?>\s*/, '');
  const RE_TAG = /<([A-Za-z_][\w\-.]*)[^>]*?>([\s\S]*?)<\/\1>/gm;
  const result: XmlMap = {}; // strong type, no `any`
  let match: RegExpExecArray | null;

  while ((match = RE_TAG.exec(xmlContent)) !== null) {
    const tagName = match[1];
    const innerContent = match[2];
    const node: XmlValue = innerContent ? parseXml(innerContent) : unescapeXml(innerContent?.trim() || '');
    if (!tagName) {
      continue;
    }
    const current = result[tagName];
    if (current === undefined) {
      // First occurrence
      result[tagName] = node;
    } else if (Array.isArray(current)) {
      // Already an array
      current.push(node);
    } else {
      // Promote to array on the second occurrence
      result[tagName] = [current, node];
    }
  }

  // No child tags? — return the text, after entity decode
  return Object.keys(result).length > 0 ? result : unescapeXml(xmlContent.trim());
};

/**
 * Encode a character as a URI percent-encoded hex value
 * @param c Character to encode
 * @returns Percent-encoded character
 */
const encodeAsHex = (c: string): string => `%${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}`;

/**
 * Escape a URI string using percent encoding
 * @param uriStr URI string to escape
 * @returns Escaped URI string
 */
export const uriEscape = (uriStr: string): string => {
  return encodeURIComponent(uriStr).replaceAll(/[!'()*]/g, encodeAsHex);
};

/**
 * Escape a URI resource path while preserving forward slashes
 * @param string URI path to escape
 * @returns Escaped URI path
 */
export const uriResourceEscape = (string: string): string => {
  return uriEscape(string).replaceAll('%2F', '/');
};

export const isListBucketResponse = (value: unknown): value is ListBucketResponse => {
  return typeof value === 'object' && value !== null && ('listBucketResult' in value || 'error' in value);
};

export const extractErrCode = (e: unknown): string | undefined => {
  if (typeof e !== 'object' || e === null) {
    return undefined;
  }
  const err = e as ErrorWithCode;
  if (typeof err.code === 'string') {
    return err.code;
  }
  return typeof err.cause?.code === 'string' ? err.cause.code : undefined;
};

export class S3Error extends Error {
  readonly code?: string;
  constructor(msg: string, code?: string, cause?: unknown) {
    super(msg);
    this.name = new.target.name; // keeps instanceof usable
    this.code = code;
    this.cause = cause;
  }
}

export class S3NetworkError extends S3Error {}
export class S3ServiceError extends S3Error {
  readonly status: number;
  readonly serviceCode?: string;
  body: string | undefined;
  constructor(msg: string, status: number, serviceCode?: string, body?: string) {
    super(msg, serviceCode);
    this.status = status;
    this.serviceCode = serviceCode;
    this.body = body;
  }
}

/**
 * Run async-returning tasks in batches with an *optional* minimum
 * spacing (minIntervalMs) between the *start* times of successive batches.
 *
 * @param {Iterable<() => Promise<unknonw>>} tasks       – functions returning Promises
 * @param {number} [batchSize=30]                    – max concurrent requests
 * @param {number} [minIntervalMs=0]                 – ≥0; 0 means “no pacing”
 * @returns {Promise<Array<PromiseSettledResult<T>>>}
 */
export const runInBatches = async <T = unknown>(
  tasks: Iterable<() => Promise<T>>,
  batchSize: number = 30,
  minIntervalMs: number = 0,
): Promise<Array<PromiseSettledResult<T>>> => {
  const allResults: PromiseSettledResult<T>[] = [];
  let batch: Array<() => Promise<T>> = [];

  for (const task of tasks) {
    batch.push(task);
    if (batch.length === batchSize) {
      await executeBatch(batch);
      batch = [];
    }
  }
  if (batch.length) {
    await executeBatch(batch);
  }
  return allResults;

  // ───────── helpers ──────────
  async function executeBatch(batchFns: ReadonlyArray<() => Promise<T>>): Promise<void> {
    const start: number = Date.now();

    const settled: Array<PromiseSettledResult<T>> = await Promise.allSettled(
      batchFns.map((fn: () => Promise<T>) => fn()),
    );
    allResults.push(...settled);

    if (minIntervalMs > 0) {
      const wait: number = minIntervalMs - (Date.now() - start);
      if (wait > 0) {
        await new Promise<void>((resolve: () => void) => setTimeout(resolve, wait));
      }
    }
  }
};

export const generateParts = async function* (data: DataInput, partSize: number): AsyncGenerator<PartData> {
  const bytes = toUint8Array(data);

  if (bytes) {
    yield* generateBufferParts(bytes, partSize);
  } else if (data instanceof Blob) {
    yield* generateBlobParts(data, partSize);
  } else if (data instanceof ReadableStream) {
    yield* generateStreamParts(data as ReadableStream<Uint8Array>, partSize);
  } else {
    throw new TypeError(`${ERROR_PREFIX}Unsupported data type for multipart upload`);
  }
};

export function* generateBufferParts(bytes: Uint8Array, partSize: number): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += partSize) {
    yield bytes.subarray(offset, Math.min(offset + partSize, bytes.byteLength));
  }
}

/**
 * Zero-copy: yields Blob slices. Data is only read when fetch consumes it.
 */
const generateBlobParts = function* (blob: Blob, partSize: number): Generator<Blob> {
  for (let offset = 0; offset < blob.size; offset += partSize) {
    yield blob.slice(offset, Math.min(offset + partSize, blob.size));
  }
};

const generateStreamParts = async function* (
  stream: ReadableStream<Uint8Array>,
  partSize: number,
): AsyncGenerator<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let buffered = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (value) {
        chunks.push(value);
        buffered += value.byteLength;

        while (buffered >= partSize) {
          yield extractPart(chunks, partSize);
          buffered -= partSize;
        }
      }

      if (done) {
        break;
      }
    }

    // Yield remaining
    if (buffered > 0) {
      yield extractPart(chunks, buffered);
    }
  } finally {
    reader.releaseLock();
  }
};

const extractPart = (chunks: Uint8Array[], size: number): ArrayBuffer => {
  const part = new Uint8Array(size);
  let offset = 0;

  while (offset < size && chunks.length > 0) {
    const chunk = chunks[0]!;
    const needed = size - offset;

    if (chunk.byteLength <= needed) {
      part.set(chunk, offset);
      offset += chunk.byteLength;
      chunks.shift();
    } else {
      part.set(chunk.subarray(0, needed), offset);
      chunks[0] = chunk.subarray(needed);
      offset = size;
    }
  }

  return part.buffer;
};

export interface PartDescriptor {
  partNumber: number;
  data: PartData;
}

/**
 * Pre-calculate all parts for known-size data.
 * Returns array of part descriptors for parallel upload.
 */
export const calculateParts = (data: DataInput, partSize: number): PartDescriptor[] => {
  const bytes = toUint8Array(data);

  if (bytes) {
    return calculateBufferParts(bytes, partSize);
  }

  if (data instanceof Blob) {
    return calculateBlobParts(data, partSize);
  }

  throw new TypeError(`${ERROR_PREFIX}Unsupported data type for part calculation`);
};

function calculateBufferParts(bytes: Uint8Array, partSize: number): PartDescriptor[] {
  const totalParts = Math.ceil(bytes.byteLength / partSize);
  const parts: PartDescriptor[] = new Array(totalParts) as PartDescriptor[];

  for (let i = 0; i < totalParts; i++) {
    const start = i * partSize;
    parts[i] = {
      partNumber: i + 1,
      data: bytes.subarray(start, Math.min(start + partSize, bytes.byteLength)),
    };
  }

  return parts;
}

function calculateBlobParts(blob: Blob, partSize: number): PartDescriptor[] {
  const totalParts = Math.ceil(blob.size / partSize);
  const parts: PartDescriptor[] = new Array(totalParts) as PartDescriptor[];

  for (let i = 0; i < totalParts; i++) {
    const start = i * partSize;
    parts[i] = {
      partNumber: i + 1,
      data: blob.slice(start, Math.min(start + partSize, blob.size)),
    };
  }

  return parts;
}
