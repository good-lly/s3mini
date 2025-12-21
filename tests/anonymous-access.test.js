'use strict';
import { it, expect, describe } from '@jest/globals';
import { S3mini } from '../dist/s3mini.js';

/**
 * Unit tests for anonymous/public S3 access (empty credentials).
 */
describe('Anonymous S3 access (empty credentials)', () => {
  it('should allow initialization with empty credentials', () => {
    expect(() => {
      new S3mini({
        accessKeyId: '',
        secretAccessKey: '',
        endpoint: 'https://public-bucket.s3.amazonaws.com',
        region: 'us-east-1',
      });
    }).not.toThrow();
  });

  it('should send requests without Authorization header when credentials are empty', async () => {
    let capturedHeaders = null;

    const mockFetch = async (url, options) => {
      capturedHeaders = options?.headers || {};
      return new Response('<?xml version="1.0"?><ListBucketResult></ListBucketResult>', {
        status: 200,
        headers: { 'Content-Type': 'application/xml' },
      });
    };

    const s3client = new S3mini({
      accessKeyId: '',
      secretAccessKey: '',
      endpoint: 'https://public-bucket.s3.amazonaws.com',
      region: 'us-east-1',
      fetch: mockFetch,
    });

    await s3client.listObjects();

    // Should NOT have Authorization header
    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders['Authorization']).toBeUndefined();
    expect(capturedHeaders['authorization']).toBeUndefined();
    
    // Should still have Host header
    expect(capturedHeaders['host']).toBeDefined();
  });

  it('should still require accessKeyId and secretAccessKey to be strings', () => {
    expect(() => {
      new S3mini({
        accessKeyId: undefined,
        secretAccessKey: '',
        endpoint: 'https://bucket.s3.amazonaws.com',
      });
    }).toThrow(TypeError);

    expect(() => {
      new S3mini({
        accessKeyId: '',
        secretAccessKey: undefined,
        endpoint: 'https://bucket.s3.amazonaws.com',
      });
    }).toThrow(TypeError);
  });

  it('should send signed requests when credentials are provided', async () => {
    let capturedHeaders = null;

    const mockFetch = async (url, options) => {
      capturedHeaders = options?.headers || {};
      return new Response('<?xml version="1.0"?><ListBucketResult></ListBucketResult>', {
        status: 200,
        headers: { 'Content-Type': 'application/xml' },
      });
    };

    const s3client = new S3mini({
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      endpoint: 'https://bucket.s3.amazonaws.com',
      region: 'us-east-1',
      fetch: mockFetch,
    });

    await s3client.listObjects();

    // Should have Authorization header when credentials are provided
    expect(capturedHeaders).toBeDefined();
    const authHeader = capturedHeaders['Authorization'] || capturedHeaders['authorization'];
    expect(authHeader).toBeDefined();
    expect(authHeader).toContain('AWS4-HMAC-SHA256');
  });

  it('should access real public S3 bucket (sentinel-cogs) without credentials', async () => {
    const s3client = new S3mini({
      accessKeyId: '',
      secretAccessKey: '',
      endpoint: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com',
      region: 'us-west-2',
    });

    const objects = await s3client.listObjects('/', '', 5);

    expect(objects).toBeInstanceOf(Array);
    expect(objects.length).toBeGreaterThan(0);
    expect(objects[0].Key).toBeDefined();
  }, 30000); // 30s timeout for network request
});
