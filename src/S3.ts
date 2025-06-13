'use strict';

import * as C from './consts.js';
import type * as IT from './types.js';
import * as U from './utils.js';

/**
 * S3 class for interacting with S3-compatible object storage services.
 * This class provides methods for common S3 operations such as uploading, downloading,
 * and deleting objects, as well as multipart uploads.
 *
 * @class
 * @example
 * const s3 = new CoreS3({
 *   accessKeyId: 'your-access-key',
 *   secretAccessKey: 'your-secret-key',
 *   endpoint: 'https://your-s3-endpoint.com',
 *   region: 'us-east-1' // by default is auto
 * });
 *
 * // Upload a file
 * await s3.putObject('example.txt', 'Hello, World!');
 *
 * // Download a file
 * const content = await s3.getObject('example.txt');
 *
 * // Delete a file
 * await s3.deleteObject('example.txt');
 */
class s3mini {
  /**
   * Creates an instance of the S3 class.
   *
   * @constructor
   * @param {Object} config - Configuration options for the S3 instance.
   * @param {string} config.accessKeyId - The access key ID for authentication.
   * @param {string} config.secretAccessKey - The secret access key for authentication.
   * @param {string} config.endpoint - The endpoint URL of the S3-compatible service.
   * @param {string} [config.region='auto'] - The region of the S3 service.
   * @param {number} [config.requestSizeInBytes=8388608] - The request size of a single request in bytes (AWS S3 is 8MB).
   * @param {number} [config.requestAbortTimeout=undefined] - The timeout in milliseconds after which a request should be aborted (careful on streamed requests).
   * @param {Object} [config.logger=null] - A logger object with methods like info, warn, error.
   * @throws {TypeError} Will throw an error if required parameters are missing or of incorrect type.
   */
  private accessKeyId: string;
  private secretAccessKey: string;
  private endpoint: string;
  private region: string;
  private requestSizeInBytes: number;
  private requestAbortTimeout?: number;
  private logger?: IT.Logger;
  private signingKeyDate?: string;
  private signingKey?: Buffer;

  constructor({
    accessKeyId,
    secretAccessKey,
    endpoint,
    region = 'auto',
    requestSizeInBytes = C.DEFAULT_REQUEST_SIZE_IN_BYTES,
    requestAbortTimeout = undefined,
    logger = undefined,
  }: IT.S3Config) {
    this._validateConstructorParams(accessKeyId, secretAccessKey, endpoint);
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.endpoint = this._ensureValidUrl(endpoint);
    this.region = region;
    this.requestSizeInBytes = requestSizeInBytes;
    this.requestAbortTimeout = requestAbortTimeout;
    this.logger = logger;
  }

  private _sanitize(obj: unknown): unknown {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }
    return Object.keys(obj).reduce(
      (acc: Record<string, unknown>, key) => {
        if (C.SENSITIVE_KEYS_REDACTED.includes(key.toLowerCase())) {
          acc[key] = '[REDACTED]';
        } else if (
          typeof (obj as Record<string, unknown>)[key] === 'object' &&
          (obj as Record<string, unknown>)[key] !== null
        ) {
          acc[key] = this._sanitize((obj as Record<string, unknown>)[key]);
        } else {
          acc[key] = (obj as Record<string, unknown>)[key];
        }
        return acc;
      },
      Array.isArray(obj) ? [] : {},
    );
  }

  private _log(
    level: 'info' | 'warn' | 'error',
    message: string,
    additionalData: Record<string, unknown> | string = {},
  ): void {
    if (this.logger && typeof this.logger[level] === 'function') {
      // Function to recursively sanitize an object

      // Sanitize the additional data
      const sanitizedData = this._sanitize(additionalData);
      // Prepare the log entry
      const logEntry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        details: sanitizedData,
        // Include some general context, but sanitize sensitive parts
        context: this._sanitize({
          region: this.region,
          endpoint: this.endpoint,
          // Only include the first few characters of the access key, if it exists
          accessKeyId: this.accessKeyId ? `${this.accessKeyId.substring(0, 4)}...` : undefined,
        }),
      };

      // Log the sanitized entry
      this.logger[level](JSON.stringify(logEntry));
    }
  }

  private _validateConstructorParams(accessKeyId: string, secretAccessKey: string, endpoint: string): void {
    if (typeof accessKeyId !== 'string' || accessKeyId.trim().length === 0) {
      throw new TypeError(C.ERROR_ACCESS_KEY_REQUIRED);
    }
    if (typeof secretAccessKey !== 'string' || secretAccessKey.trim().length === 0) {
      throw new TypeError(C.ERROR_SECRET_KEY_REQUIRED);
    }
    if (typeof endpoint !== 'string' || endpoint.trim().length === 0) {
      throw new TypeError(C.ERROR_ENDPOINT_REQUIRED);
    }
  }

  private _ensureValidUrl(raw: string): string {
    // prepend https:// if user forgot a scheme
    const candidate = /^(https?:)?\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      new URL(candidate);
      return candidate.replace(/\/+$/, ''); // strip trailing slash
    } catch {
      const msg = `${C.ERROR_ENDPOINT_FORMAT} But provided: "${raw}"`;
      this._log('error', msg);
      throw new TypeError(msg);
    }
  }

  private _validateMethodIsGetOrHead(method: string): void {
    if (method !== 'GET' && method !== 'HEAD') {
      this._log('error', `${C.ERROR_PREFIX}method must be either GET or HEAD`);
      throw new Error('method must be either GET or HEAD');
    }
  }

  private _checkKey(key: string): void {
    if (typeof key !== 'string' || key.trim().length === 0) {
      this._log('error', C.ERROR_KEY_REQUIRED);
      throw new TypeError(C.ERROR_KEY_REQUIRED);
    }
  }

  private _checkDelimiter(delimiter: string): void {
    if (typeof delimiter !== 'string' || delimiter.trim().length === 0) {
      this._log('error', C.ERROR_DELIMITER_REQUIRED);
      throw new TypeError(C.ERROR_DELIMITER_REQUIRED);
    }
  }

  private _checkPrefix(prefix: string): void {
    if (typeof prefix !== 'string') {
      this._log('error', C.ERROR_PREFIX_TYPE);
      throw new TypeError(C.ERROR_PREFIX_TYPE);
    }
  }

  // private _checkMaxKeys(maxKeys: number): void {
  //   if (typeof maxKeys !== 'number' || maxKeys <= 0) {
  //     this._log('error', C.ERROR_MAX_KEYS_TYPE);
  //     throw new TypeError(C.ERROR_MAX_KEYS_TYPE);
  //   }
  // }

  private _checkOpts(opts: object): void {
    if (typeof opts !== 'object') {
      this._log('error', `${C.ERROR_PREFIX}opts must be an object`);
      throw new TypeError(`${C.ERROR_PREFIX}opts must be an object`);
    }
  }

  private _filterIfHeaders(opts: Record<string, unknown>): {
    filteredOpts: Record<string, string>;
    conditionalHeaders: Record<string, unknown>;
  } {
    const filteredOpts: Record<string, string> = {};
    const conditionalHeaders: Record<string, unknown> = {};
    const ifHeaders = ['if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'];

    for (const [key, value] of Object.entries(opts)) {
      if (ifHeaders.includes(key.toLowerCase())) {
        // Convert to lowercase for consistency
        conditionalHeaders[key] = value;
      } else {
        filteredOpts[key] = value as string;
      }
    }

    return { filteredOpts, conditionalHeaders };
  }

  private _validateUploadPartParams(
    key: string,
    uploadId: string,
    data: Buffer | string,
    partNumber: number,
    opts: object,
  ): void {
    this._checkKey(key);
    if (!(data instanceof Buffer || typeof data === 'string')) {
      this._log('error', C.ERROR_DATA_BUFFER_REQUIRED);
      throw new TypeError(C.ERROR_DATA_BUFFER_REQUIRED);
    }
    if (typeof uploadId !== 'string' || uploadId.trim().length === 0) {
      this._log('error', C.ERROR_UPLOAD_ID_REQUIRED);
      throw new TypeError(C.ERROR_UPLOAD_ID_REQUIRED);
    }
    if (!Number.isInteger(partNumber) || partNumber <= 0) {
      this._log('error', `${C.ERROR_PREFIX}partNumber must be a positive integer`);
      throw new TypeError(`${C.ERROR_PREFIX}partNumber must be a positive integer`);
    }
    this._checkOpts(opts);
  }

  private _sign(
    method: IT.HttpMethod,
    keyPath: string,
    query: Record<string, unknown> = {},
    headers: Record<string, string | number> = {},
  ): { url: string; headers: Record<string, string | number> } {
    // Create URL without appending keyPath first
    const url = new URL(this.endpoint);

    // Properly format the pathname to avoid double slashes
    if (keyPath && keyPath.length > 0) {
      url.pathname =
        url.pathname === '/' ? `/${keyPath.replace(/^\/+/, '')}` : `${url.pathname}/${keyPath.replace(/^\/+/, '')}`;
    }

    const fullDatetime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const shortDatetime = fullDatetime.slice(0, 8);
    const credentialScope = this._buildCredentialScope(shortDatetime);

    headers[C.HEADER_AMZ_CONTENT_SHA256] = C.UNSIGNED_PAYLOAD; // body ? U.hash(body) : C.UNSIGNED_PAYLOAD;
    headers[C.HEADER_AMZ_DATE] = fullDatetime;
    headers[C.HEADER_HOST] = url.host;
    const canonicalHeaders = this._buildCanonicalHeaders(headers);
    const signedHeaders = Object.keys(headers)
      .map(key => key.toLowerCase())
      .sort()
      .join(';');

    const canonicalRequest = this._buildCanonicalRequest(method, url, query, canonicalHeaders, signedHeaders);
    const stringToSign = this._buildStringToSign(fullDatetime, credentialScope, canonicalRequest);
    const signature = this._calculateSignature(shortDatetime, stringToSign);
    const authorizationHeader = this._buildAuthorizationHeader(credentialScope, signedHeaders, signature);
    headers[C.HEADER_AUTHORIZATION] = authorizationHeader;
    return { url: url.toString(), headers };
  }

  private _buildCanonicalHeaders(headers: Record<string, string | number>): string {
    return Object.entries(headers)
      .map(([key, value]) => `${key.toLowerCase()}:${String(value).trim()}`)
      .sort()
      .join('\n');
  }

  private _buildCanonicalRequest(
    method: IT.HttpMethod,
    url: URL,
    query: Record<string, unknown>,
    canonicalHeaders: string,
    signedHeaders: string,
  ): string {
    return [
      method,
      url.pathname,
      this._buildCanonicalQueryString(query),
      `${canonicalHeaders}\n`,
      signedHeaders,
      C.UNSIGNED_PAYLOAD,
    ].join('\n');
  }

  private _buildCredentialScope(shortDatetime: string): string {
    return [shortDatetime, this.region, C.S3_SERVICE, C.AWS_REQUEST_TYPE].join('/');
  }

  private _buildStringToSign(fullDatetime: string, credentialScope: string, canonicalRequest: string): string {
    return [C.AWS_ALGORITHM, fullDatetime, credentialScope, U.hash(canonicalRequest)].join('\n');
  }

  private _calculateSignature(shortDatetime: string, stringToSign: string): string {
    if (shortDatetime !== this.signingKeyDate) {
      this.signingKeyDate = shortDatetime;
      this.signingKey = this._getSignatureKey(shortDatetime);
    }
    return U.hmac(this.signingKey!, stringToSign, 'hex') as string;
  }

  private _buildAuthorizationHeader(credentialScope: string, signedHeaders: string, signature: string): string {
    return [
      `${C.AWS_ALGORITHM} Credential=${this.accessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`,
    ].join(', ');
  }

  private async _signedRequest(
    method: IT.HttpMethod, // 'GET' | 'HEAD' | 'PUT' | 'POST' | 'DELETE'
    key: string, // ‘’ allowed for bucket‑level ops
    {
      query = {}, // ?query=string
      body = '', // string | Buffer | undefined
      headers = {}, // extra/override headers
      tolerated = [], // [200, 404] etc.
      withQuery = false, // append query string to signed URL
    }: {
      query?: Record<string, unknown>;
      body?: string | Buffer | undefined;
      headers?: Record<string, string | number | undefined>;
      tolerated?: number[] | undefined;
      withQuery?: boolean | undefined;
    } = {},
  ): Promise<Response> {
    // Basic validation
    if (!['GET', 'HEAD', 'PUT', 'POST', 'DELETE'].includes(method)) {
      throw new Error(`${C.ERROR_PREFIX}Unsupported HTTP method ${method as string}`);
    }
    if (key) {
      this._checkKey(key); // allow '' for bucket‑level
    }

    const { filteredOpts, conditionalHeaders } = ['GET', 'HEAD'].includes(method)
      ? this._filterIfHeaders(query)
      : { filteredOpts: query, conditionalHeaders: {} };

    const baseHeaders: Record<string, string | number> = {
      [C.HEADER_AMZ_CONTENT_SHA256]: C.UNSIGNED_PAYLOAD,
      // ...(['GET', 'HEAD'].includes(method) ? { [C.HEADER_CONTENT_TYPE]: C.JSON_CONTENT_TYPE } : {}),
      ...headers,
      ...conditionalHeaders,
    };

    const encodedKey = key ? U.uriResourceEscape(key) : '';
    const { url, headers: signedHeaders } = this._sign(method, encodedKey, filteredOpts, baseHeaders);
    if (Object.keys(query).length > 0) {
      withQuery = true; // append query string to signed URL
    }
    const filteredOptsStrings = Object.fromEntries(
      Object.entries(filteredOpts).map(([k, v]) => [k, String(v)]),
    ) as Record<string, string>;
    const finalUrl =
      withQuery && Object.keys(filteredOpts).length ? `${url}?${new URLSearchParams(filteredOptsStrings)}` : url;
    const signedHeadersString = Object.fromEntries(
      Object.entries(signedHeaders).map(([k, v]) => [k, String(v)]),
    ) as Record<string, string>;
    return this._sendRequest(finalUrl, method, signedHeadersString, body, tolerated);
  }

  public getProps(): IT.S3Config {
    return {
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      endpoint: this.endpoint,
      region: this.region,
      requestSizeInBytes: this.requestSizeInBytes,
      requestAbortTimeout: this.requestAbortTimeout,
      logger: this.logger,
    };
  }
  public setProps(props: IT.S3Config): void {
    this._validateConstructorParams(props.accessKeyId, props.secretAccessKey, props.endpoint);
    this.accessKeyId = props.accessKeyId;
    this.secretAccessKey = props.secretAccessKey;
    this.region = props.region || 'auto';
    this.endpoint = props.endpoint;
    this.requestSizeInBytes = props.requestSizeInBytes || C.DEFAULT_REQUEST_SIZE_IN_BYTES;
    this.requestAbortTimeout = props.requestAbortTimeout;
    this.logger = props.logger;
  }

  public sanitizeETag(etag: string): string {
    return U.sanitizeETag(etag);
  }

  // TBD
  public async createBucket(): Promise<boolean> {
    const xmlBody = `
      <CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
        <LocationConstraint>${this.region}</LocationConstraint>
      </CreateBucketConfiguration>
    `;
    const headers = {
      [C.HEADER_CONTENT_TYPE]: C.XML_CONTENT_TYPE,
      [C.HEADER_CONTENT_LENGTH]: Buffer.byteLength(xmlBody).toString(),
    };
    const res = await this._signedRequest('PUT', '', {
      body: xmlBody,
      headers,
      tolerated: [200, 404, 403, 409], // don’t throw on 404/403 // 409 = bucket already exists
    });
    return res.status === 200;
  }

  public async bucketExists(): Promise<boolean> {
    const res = await this._signedRequest('HEAD', '', { tolerated: [200, 404, 403] });
    return res.status === 200;
  }

  public async listObjects(
    delimiter: string = '/',
    prefix: string = '',
    maxKeys?: number,
    // method: IT.HttpMethod = 'GET', // 'GET' or 'HEAD'
    opts: Record<string, unknown> = {},
  ): Promise<object[] | null> {
    this._checkDelimiter(delimiter);
    this._checkPrefix(prefix);
    this._checkOpts(opts);

    const keyPath = delimiter === '/' ? delimiter : U.uriEscape(delimiter);

    const unlimited = !(maxKeys && maxKeys > 0);
    let remaining = unlimited ? Infinity : maxKeys;
    let token: string | undefined;
    const all: object[] = [];

    do {
      const batchSize = Math.min(remaining, 1000); // S3 ceiling
      const query: Record<string, unknown> = {
        'list-type': C.LIST_TYPE, // =2 for V2
        'max-keys': String(batchSize),
        ...(prefix ? { prefix } : {}),
        ...(token ? { 'continuation-token': token } : {}),
        ...opts,
      };

      const res = await this._signedRequest('GET', keyPath, {
        query,
        withQuery: true,
        tolerated: [200, 404],
      });

      if (res.status === 404) {
        return null;
      }
      if (res.status !== 200) {
        const errorBody = await res.text();
        const errorCode = res.headers.get('x-amz-error-code') || 'Unknown';
        const errorMessage = res.headers.get('x-amz-error-message') || res.statusText;
        this._log(
          'error',
          `${C.ERROR_PREFIX}Request failed with status ${res.status}: ${errorCode} - ${errorMessage}, err body: ${errorBody}`,
        );
        throw new Error(
          `${C.ERROR_PREFIX}Request failed with status ${res.status}: ${errorCode} - ${errorMessage}, err body: ${errorBody}`,
        );
      }

      const raw = U.parseXml(await res.text()) as Record<string, unknown>;
      if (typeof raw !== 'object' || !raw || 'error' in raw) {
        this._log('error', `${C.ERROR_PREFIX}Unexpected listObjects response shape: ${JSON.stringify(raw)}`);
        throw new Error(`${C.ERROR_PREFIX}Unexpected listObjects response shape`);
      }
      const out = ('listBucketResult' in raw ? raw.listBucketResult : raw) as Record<string, unknown>;

      /* accumulate Contents */
      const contents = out.contents;
      if (contents) {
        const batch = Array.isArray(contents) ? contents : [contents];
        all.push(...(batch as object[]));
        if (!unlimited) {
          remaining -= batch.length;
        }
      }
      const truncated = out.isTruncated === 'true' || out.IsTruncated === 'true';
      token = truncated
        ? ((out.nextContinuationToken || out.NextContinuationToken || out.nextMarker || out.NextMarker) as
            | string
            | undefined)
        : undefined;
    } while (token && remaining > 0);

    return all;
  }

  public async listMultipartUploads(
    delimiter: string = '/',
    prefix: string = '',
    method: IT.HttpMethod = 'GET',
    opts: Record<string, string | number | boolean | undefined> = {},
  ): Promise<IT.ListMultipartUploadSuccess | IT.MultipartUploadError> {
    this._checkDelimiter(delimiter);
    this._checkPrefix(prefix);
    this._validateMethodIsGetOrHead(method);
    this._checkOpts(opts);

    const query = { uploads: '', ...opts };
    const keyPath = delimiter === '/' ? delimiter : U.uriEscape(delimiter);

    const res = await this._signedRequest(method, keyPath, {
      query,
      withQuery: true,
    });
    // doublecheck if this is needed
    // if (method === 'HEAD') {
    //   return {
    //     size: +(res.headers.get(C.HEADER_CONTENT_LENGTH) ?? '0'),
    //     mtime: res.headers.get(C.HEADER_LAST_MODIFIED) ? new Date(res.headers.get(C.HEADER_LAST_MODIFIED)!) : undefined,
    //     etag: res.headers.get(C.HEADER_ETAG) ?? '',
    //   };
    // }

    const raw = U.parseXml(await res.text()) as unknown;
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`${C.ERROR_PREFIX}Unexpected listMultipartUploads response shape`);
    }
    if ('listMultipartUploadsResult' in raw) {
      return raw.listMultipartUploadsResult as IT.ListMultipartUploadSuccess;
    }
    return raw as IT.MultipartUploadError;
  }

  public async getObject(key: string, opts: Record<string, unknown> = {}): Promise<string | null> {
    const res = await this._signedRequest('GET', key, { query: opts, tolerated: [200, 404, 412, 304] });
    if ([404, 412, 304].includes(res.status)) {
      return null;
    }
    return res.text();
  }

  public async getObjectResponse(key: string, opts: Record<string, unknown> = {}): Promise<Response | null> {
    const res = await this._signedRequest('GET', key, { query: opts, tolerated: [200, 404, 412, 304] });
    if ([404, 412, 304].includes(res.status)) {
      return null;
    }
    return res;
  }

  public async getObjectArrayBuffer(key: string, opts: Record<string, unknown> = {}): Promise<ArrayBuffer | null> {
    const res = await this._signedRequest('GET', key, { query: opts, tolerated: [200, 404, 412, 304] });
    if ([404, 412, 304].includes(res.status)) {
      return null;
    }
    return res.arrayBuffer();
  }

  public async getObjectJSON<T = unknown>(key: string, opts: Record<string, unknown> = {}): Promise<T | null> {
    const res = await this._signedRequest('GET', key, { query: opts, tolerated: [200, 404, 412, 304] });
    if ([404, 412, 304].includes(res.status)) {
      return null;
    }
    return res.json() as Promise<T>;
  }

  public async getObjectWithETag(
    key: string,
    opts: Record<string, unknown> = {},
  ): Promise<{ etag: string | null; data: ArrayBuffer | null }> {
    try {
      const res = await this._signedRequest('GET', key, { query: opts, tolerated: [200, 404, 412, 304] });

      if ([404, 412, 304].includes(res.status)) {
        return { etag: null, data: null };
      }

      const etag = res.headers.get(C.HEADER_ETAG);
      if (!etag) {
        throw new Error('ETag not found in response headers');
      }
      return { etag: U.sanitizeETag(etag), data: await res.arrayBuffer() };
    } catch (err) {
      this._log('error', `Error getting object ${key} with ETag: ${String(err)}`);
      throw err;
    }
  }

  public async getObjectRaw(
    key: string,
    wholeFile = true,
    rangeFrom = 0,
    rangeTo = this.requestSizeInBytes,
    opts: Record<string, unknown> = {},
  ): Promise<Response> {
    const rangeHdr: Record<string, string | number> = wholeFile ? {} : { range: `bytes=${rangeFrom}-${rangeTo - 1}` };

    return this._signedRequest('GET', key, {
      query: { ...opts },
      headers: rangeHdr,
      withQuery: true, // keep ?query=string behaviour
    });
  }

  public async getContentLength(key: string): Promise<number> {
    const res = await this._signedRequest('HEAD', key);
    const len = res.headers.get(C.HEADER_CONTENT_LENGTH);
    return len ? +len : 0;
  }

  public async objectExists(key: string, opts: Record<string, unknown> = {}): Promise<IT.ExistResponseCode> {
    const res = await this._signedRequest('HEAD', key, {
      query: opts,
      tolerated: [200, 404, 412, 304],
    });

    if (res.status === 404) {
      return false; // not found
    }
    if (res.status === 412 || res.status === 304) {
      return null; // ETag mismatch
    }
    return true; // found (200)
  }

  public async getEtag(key: string, opts: Record<string, unknown> = {}): Promise<string | null> {
    const res = await this._signedRequest('HEAD', key, {
      query: opts,
      tolerated: [200, 404],
    });

    if (res.status === 404) {
      return null;
    }

    const etag = res.headers.get(C.HEADER_ETAG);
    if (!etag) {
      throw new Error('ETag not found in response headers');
    }

    return U.sanitizeETag(etag);
  }

  public async putObject(key: string, data: string | Buffer): Promise<Response> {
    if (!(data instanceof Buffer || typeof data === 'string')) {
      throw new TypeError(C.ERROR_DATA_BUFFER_REQUIRED);
    }
    return this._signedRequest('PUT', key, {
      body: data,
      headers: { [C.HEADER_CONTENT_LENGTH]: typeof data === 'string' ? Buffer.byteLength(data) : data.length },
      tolerated: [200],
    });
  }

  public async getMultipartUploadId(key: string, fileType: string = C.DEFAULT_STREAM_CONTENT_TYPE): Promise<string> {
    this._checkKey(key);
    if (typeof fileType !== 'string') {
      throw new TypeError(`${C.ERROR_PREFIX}fileType must be a string`);
    }
    const query = { uploads: '' };
    const headers = { [C.HEADER_CONTENT_TYPE]: fileType };

    const res = await this._signedRequest('POST', key, {
      query,
      headers,
      withQuery: true,
    });

    const parsed = U.parseXml(await res.text()) as unknown;

    if (
      parsed &&
      typeof parsed === 'object' &&
      'initiateMultipartUploadResult' in parsed &&
      parsed.initiateMultipartUploadResult &&
      'uploadId' in (parsed.initiateMultipartUploadResult as { uploadId: string })
    ) {
      return (parsed.initiateMultipartUploadResult as { uploadId: string }).uploadId;
    }

    throw new Error(`${C.ERROR_PREFIX}Failed to create multipart upload: ${JSON.stringify(parsed)}`);
  }

  public async uploadPart(
    key: string,
    uploadId: string,
    data: Buffer | string,
    partNumber: number,
    opts: Record<string, unknown> = {},
  ): Promise<IT.UploadPart> {
    this._validateUploadPartParams(key, uploadId, data, partNumber, opts);

    const query = { uploadId, partNumber, ...opts };
    const res = await this._signedRequest('PUT', key, {
      query,
      body: data,
      headers: { [C.HEADER_CONTENT_LENGTH]: typeof data === 'string' ? Buffer.byteLength(data) : data.length },
    });

    return { partNumber, etag: U.sanitizeETag(res.headers.get('etag') || '') };
  }

  public async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<IT.UploadPart>,
  ): Promise<IT.CompleteMultipartUploadResult> {
    // …existing validation left untouched …

    const query = { uploadId };
    const xmlBody = this._buildCompleteMultipartUploadXml(parts);
    const headers = {
      [C.HEADER_CONTENT_TYPE]: C.XML_CONTENT_TYPE,
      [C.HEADER_CONTENT_LENGTH]: Buffer.byteLength(xmlBody).toString(),
    };

    const res = await this._signedRequest('POST', key, {
      query,
      body: xmlBody,
      headers,
      withQuery: true,
    });

    const parsed = U.parseXml(await res.text()) as unknown;

    const result: unknown =
      parsed && typeof parsed === 'object' && 'completeMultipartUploadResult' in parsed
        ? (parsed as { completeMultipartUploadResult: unknown }).completeMultipartUploadResult
        : parsed;

    if (!result || typeof result !== 'object') {
      throw new Error(`${C.ERROR_PREFIX}Failed to complete multipart upload: ${JSON.stringify(parsed)}`);
    }
    if ('ETag' in result || 'eTag' in result) {
      (result as IT.CompleteMultipartUploadResult).etag = this.sanitizeETag(
        (result as IT.CompleteMultipartUploadResult).eTag ?? (result as IT.CompleteMultipartUploadResult).ETag,
      );
    }
    return result as IT.CompleteMultipartUploadResult;
  }

  public async abortMultipartUpload(key: string, uploadId: string): Promise<object> {
    this._checkKey(key);
    if (!uploadId) {
      throw new TypeError(C.ERROR_UPLOAD_ID_REQUIRED);
    }

    const query = { uploadId };
    const headers = { [C.HEADER_CONTENT_TYPE]: C.XML_CONTENT_TYPE };

    const res = await this._signedRequest('DELETE', key, {
      query,
      headers,
      withQuery: true,
    });

    const parsed = U.parseXml(await res.text()) as object;
    if (
      parsed &&
      'error' in parsed &&
      typeof parsed.error === 'object' &&
      parsed.error !== null &&
      'message' in parsed.error
    ) {
      this._log('error', `${C.ERROR_PREFIX}Failed to abort multipart upload: ${String(parsed.error.message)}`);
      throw new Error(`${C.ERROR_PREFIX}Failed to abort multipart upload: ${String(parsed.error.message)}`);
    }
    return { status: 'Aborted', key, uploadId, response: parsed };
  }

  private _buildCompleteMultipartUploadXml(parts: Array<IT.UploadPart>): string {
    return `
      <CompleteMultipartUpload>
        ${parts
          .map(
            part => `
          <Part>
            <PartNumber>${part.partNumber}</PartNumber>
            <ETag>${part.etag}</ETag>
          </Part>
        `,
          )
          .join('')}
      </CompleteMultipartUpload>
    `;
  }

  public async deleteObject(key: string): Promise<boolean> {
    const res = await this._signedRequest('DELETE', key, { tolerated: [200, 204] });
    return res.status === 200 || res.status === 204;
  }

  private async _sendRequest(
    url: string,
    method: IT.HttpMethod,
    headers: Record<string, string>,
    body?: string | Buffer,
    toleratedStatusCodes: number[] = [],
  ): Promise<Response> {
    this._log('info', `Sending ${method} request to ${url}`, `headers: ${JSON.stringify(headers)}`);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: ['GET', 'HEAD'].includes(method) ? undefined : (body as string),
        signal: this.requestAbortTimeout !== undefined ? AbortSignal.timeout(this.requestAbortTimeout) : undefined,
      });
      this._log('info', `Response status: ${res.status}, tolerated: ${toleratedStatusCodes.join(',')}`);
      if (!res.ok && !toleratedStatusCodes.includes(res.status)) {
        await this._handleErrorResponse(res);
      }
      return res;
    } catch (err: unknown) {
      const code = U.extractErrCode(err);
      if (code && ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED'].includes(code)) {
        throw new U.S3NetworkError(`S3 network error: ${code}`, code, err);
      }
      throw err;
    }
  }

  private async _handleErrorResponse(res: Response): Promise<void> {
    const errorBody = await res.text();
    const svcCode = res.headers.get('x-amz-error-code') ?? 'Unknown';
    const errorMessage = res.headers.get('x-amz-error-message') || res.statusText;
    this._log(
      'error',
      `${C.ERROR_PREFIX}Request failed with status ${res.status}: ${svcCode} - ${errorMessage},err body: ${errorBody}`,
    );
    throw new U.S3ServiceError(`S3 returned ${res.status} – ${svcCode}`, res.status, svcCode, errorBody);
  }

  private _buildCanonicalQueryString(queryParams: Record<string, unknown>): string {
    if (!queryParams || Object.keys(queryParams).length === 0) {
      return '';
    }
    return Object.keys(queryParams)
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key] as string)}`)
      .sort()
      .join('&');
  }
  private _getSignatureKey(dateStamp: string): Buffer {
    const kDate = U.hmac(`AWS4${this.secretAccessKey}`, dateStamp) as Buffer;
    const kRegion = U.hmac(kDate, this.region) as Buffer;
    const kService = U.hmac(kRegion, C.S3_SERVICE) as Buffer;
    return U.hmac(kService, C.AWS_REQUEST_TYPE) as Buffer;
  }
}

export { s3mini };
export default s3mini;
