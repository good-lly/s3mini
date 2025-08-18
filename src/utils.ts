'use strict';
import type { XmlValue, XmlMap, ListBucketResponse, ErrorWithCode } from './types.js';

/**
 * Hash content using SHA-256
 * @param {string|Buffer} content  – data to hash
 * @param {BufferEncoding} [encoding='hex'] – hex | base64 | …
 * @returns {string} Hex encoded hash

 */
export const sha256 = async (content: string | Buffer, encoding: BufferEncoding = 'hex'): Promise<string> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(content.toString());
  const hash = await globalThis.crypto.subtle.digest('SHA-256', data);

  return Buffer.from(hash).toString(encoding);
};

/**
 * Compute HMAC-SHA-256 of arbitrary data and return a hex string.
 * @param {string|Buffer} key      – secret key
 * @param {string|Buffer} content  – data to authenticate
 * @param {('hex' | 'base64')} [encoding] – optional string encoding
 * @returns {string | Buffer} string encoded or raw HMAC
 */
export const hmac = async (
  key: string | Buffer,
  content: string | Buffer,
  encoding?: 'hex' | 'base64',
): Promise<string | Buffer> => {
  const encoder = new TextEncoder();
  const secret = await globalThis.crypto.subtle.importKey(
    'raw',
    Buffer.from(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const data = encoder.encode(content.toString('utf-8'));
  const mac = await globalThis.crypto.subtle.sign('HMAC', secret, data);

  return encoding ? Buffer.from(mac).toString(encoding) : Buffer.from(mac);
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
    '&QUOT;': '',
    '&#x00022': '',
  };
  return etag.replace(/(^("|&quot;|&#34;))|(("|&quot;|&#34;)$)/g, m => replaceChars[m] as string);
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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

const unescapeXml = (value: string): string =>
  value.replace(/&(quot|apos|lt|gt|amp);/g, m => entityMap[m as keyof typeof entityMap] ?? m);

/**
 * Parse a very small subset of XML into a JS structure.
 *
 * @param input raw XML string
 * @returns string for leaf nodes, otherwise a map of children
 */

export const parseXml = (input: string): XmlValue => {
  const xmlContent = input.replace(/<\?xml[^?]*\?>\s*/, '');
  const RE_TAG = /<([A-Za-z_][\w\-.]*)[^>]*>([\s\S]*?)<\/\1>/gm;
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
const encodeAsHex = (c: string): string => `%${c.charCodeAt(0).toString(16).toUpperCase()}`;

/**
 * Escape a URI string using percent encoding
 * @param uriStr URI string to escape
 * @returns Escaped URI string
 */
export const uriEscape = (uriStr: string): string => {
  return encodeURIComponent(uriStr).replace(/[!'()*]/g, encodeAsHex);
};

/**
 * Escape a URI resource path while preserving forward slashes
 * @param string URI path to escape
 * @returns Escaped URI path
 */
export const uriResourceEscape = (string: string): string => {
  return uriEscape(string).replace(/%2F/g, '/');
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
