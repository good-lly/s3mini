'use strict';
import { describe, it, expect } from '@jest/globals';
import { S3mini } from '../dist/s3mini.js';

describe('getPresignedUrl', () => {
  const s3 = new S3mini({
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    endpoint: 'https://my-bucket.s3.us-east-1.amazonaws.com',
    region: 'us-east-1',
  });

  const s3PathStyle = new S3mini({
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    endpoint: 'https://s3.us-east-1.amazonaws.com/my-bucket',
    region: 'us-east-1',
  });

  it('returns a valid URL string for GET', async () => {
    const url = await s3.getPresignedUrl('GET', 'test-key');
    expect(typeof url).toBe('string');
    const parsed = new URL(url);
    expect(parsed.protocol).toBe('https:');
    expect(parsed.hostname).toBe('my-bucket.s3.us-east-1.amazonaws.com');
    expect(parsed.pathname).toBe('/test-key');
  });

  it('returns a valid URL string for PUT', async () => {
    const url = await s3.getPresignedUrl('PUT', 'test-key');
    expect(typeof url).toBe('string');
    const parsed = new URL(url);
    expect(parsed.protocol).toBe('https:');
    expect(parsed.pathname).toBe('/test-key');
  });

  it('contains required AWS query parameters', async () => {
    const url = await s3.getPresignedUrl('GET', 'test-key', 3600);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(parsed.searchParams.get('X-Amz-Credential')).toContain('test-access-key');
    expect(parsed.searchParams.get('X-Amz-Credential')).toContain('us-east-1');
    expect(parsed.searchParams.get('X-Amz-Credential')).toContain('s3');
    expect(parsed.searchParams.get('X-Amz-Credential')).toContain('aws4_request');
    expect(parsed.searchParams.get('X-Amz-Date')).toMatch(/^\d{8}T\d{6}Z$/);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(parsed.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('includes nested object key in the path', async () => {
    const url = await s3.getPresignedUrl('GET', 'path/to/file.txt');
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/path/to/file.txt');
  });

  it('works with path-style endpoint', async () => {
    const url = await s3PathStyle.getPresignedUrl('GET', 'file.txt');
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('s3.us-east-1.amazonaws.com');
    expect(parsed.pathname).toBe('/my-bucket/file.txt');
  });

  it('throws on empty key', async () => {
    await expect(s3.getPresignedUrl('GET', '')).rejects.toThrow('[s3mini]');
  });

  it('throws on expiresIn <= 0', async () => {
    await expect(s3.getPresignedUrl('GET', 'key', 0)).rejects.toThrow('expiresIn');
    await expect(s3.getPresignedUrl('GET', 'key', -1)).rejects.toThrow('expiresIn');
  });

  it('throws on expiresIn > 604800', async () => {
    await expect(s3.getPresignedUrl('GET', 'key', 604801)).rejects.toThrow('expiresIn');
  });

  it('throws on non-finite expiresIn', async () => {
    await expect(s3.getPresignedUrl('GET', 'key', NaN)).rejects.toThrow('expiresIn');
    await expect(s3.getPresignedUrl('GET', 'key', Infinity)).rejects.toThrow('expiresIn');
  });

  it('accepts max expiresIn of 604800', async () => {
    const url = await s3.getPresignedUrl('GET', 'key', 604800);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('604800');
  });

  it('floors non-integer expiresIn', async () => {
    const url = await s3.getPresignedUrl('GET', 'key', 300.9);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('defaults expiresIn to 3600', async () => {
    const url = await s3.getPresignedUrl('GET', 'key');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('3600');
  });

  it('includes additional query parameters', async () => {
    const url = await s3.getPresignedUrl('GET', 'report.pdf', 3600, {
      'response-content-type': 'application/pdf',
      'response-content-disposition': 'attachment; filename="report.pdf"',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(parsed.searchParams.get('response-content-disposition')).toBe('attachment; filename="report.pdf"');
  });

  it('produces different signatures for GET vs PUT', async () => {
    const getUrl = await s3.getPresignedUrl('GET', 'same-key');
    const putUrl = await s3.getPresignedUrl('PUT', 'same-key');
    const getSig = new URL(getUrl).searchParams.get('X-Amz-Signature');
    const putSig = new URL(putUrl).searchParams.get('X-Amz-Signature');
    expect(getSig).not.toBe(putSig);
  });

  it('produces different signatures for different keys', async () => {
    const url1 = await s3.getPresignedUrl('GET', 'key-one');
    const url2 = await s3.getPresignedUrl('GET', 'key-two');
    const sig1 = new URL(url1).searchParams.get('X-Amz-Signature');
    const sig2 = new URL(url2).searchParams.get('X-Amz-Signature');
    expect(sig1).not.toBe(sig2);
  });

  it('handles special characters in key', async () => {
    const url = await s3.getPresignedUrl('GET', 'path/to/file with spaces.txt');
    expect(typeof url).toBe('string');
    const parsed = new URL(url);
    expect(parsed.pathname).toContain('file%20with%20spaces.txt');
  });

  it('handles unicode characters in key', async () => {
    const url = await s3.getPresignedUrl('GET', 'docs/résumé.pdf');
    expect(typeof url).toBe('string');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces deterministic output for same inputs within same second', async () => {
    const url1 = await s3.getPresignedUrl('GET', 'deterministic-key', 3600);
    const url2 = await s3.getPresignedUrl('GET', 'deterministic-key', 3600);
    expect(url1).toBe(url2);
  });

  it('credential scope contains correct date format', async () => {
    const url = await s3.getPresignedUrl('GET', 'key');
    const parsed = new URL(url);
    const credential = parsed.searchParams.get('X-Amz-Credential');
    // Format: accessKeyId/YYYYMMDD/region/s3/aws4_request
    expect(credential).toMatch(/^test-access-key\/\d{8}\/us-east-1\/s3\/aws4_request$/);
  });

  it('date param matches credential scope date', async () => {
    const url = await s3.getPresignedUrl('GET', 'key');
    const parsed = new URL(url);
    const date = parsed.searchParams.get('X-Amz-Date');
    const credential = parsed.searchParams.get('X-Amz-Credential');
    const dateFromCredential = credential.split('/')[1];
    expect(date.slice(0, 8)).toBe(dateFromCredential);
  });

  it('works with endpoint that has a port', async () => {
    const s3WithPort = new S3mini({
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      endpoint: 'http://localhost:9000/test-bucket',
      region: 'us-east-1',
    });
    const url = await s3WithPort.getPresignedUrl('GET', 'file.txt');
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('localhost');
    expect(parsed.port).toBe('9000');
    expect(parsed.pathname).toBe('/test-bucket/file.txt');
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not include Authorization header params in URL', async () => {
    const url = await s3.getPresignedUrl('GET', 'key');
    expect(url).not.toContain('Authorization');
    expect(url).not.toContain('x-amz-content-sha256');
  });
});
