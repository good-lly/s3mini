'use strict';

import { S3mini } from '../dist/index.mjs';
import * as dotenv from 'dotenv';
dotenv.config();

const name = 'minio';
const bucketName = `BUCKET_ENV_${name.toUpperCase()}`;
const raw = process.env[bucketName] ? process.env[bucketName].split(',') : null;

if (!raw) {
  describe.skip('custom-fetch', () => {
    it('skipped', () => {
      expect(true).toBe(true);
    });
  });
} else {
  const bucket = {
    provider: raw[0],
    accessKeyId: raw[1],
    secretAccessKey: raw[2],
    endpoint: raw[3],
    region: raw[4],
  };

  const KEY_PREFIX = `custom-fetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}/`;

  describe(':::: custom-fetch ::::', () => {
    beforeAll(async () => {
      const s3client = new S3mini({
        accessKeyId: bucket.accessKeyId,
        secretAccessKey: bucket.secretAccessKey,
        endpoint: bucket.endpoint,
        region: bucket.region,
      });
      if (!(await s3client.bucketExists())) {
        await s3client.createBucket();
      }
    });

    it('uses custom fetch implementation', async () => {
      const fetchCalls = [];

      const customFetch = async (url, options) => {
        fetchCalls.push({ url, method: options?.method || 'GET' });
        return globalThis.fetch(url, options);
      };

      const s3client = new S3mini({
        accessKeyId: bucket.accessKeyId,
        secretAccessKey: bucket.secretAccessKey,
        endpoint: bucket.endpoint,
        region: bucket.region,
        fetch: customFetch,
      });

      const testKey = `${KEY_PREFIX}roundtrip.txt`;
      const testContent = 'Testing custom fetch implementation';

      fetchCalls.length = 0;
      await s3client.putObject(testKey, testContent);

      expect(fetchCalls.length).toBeGreaterThan(0);
      const putCall = fetchCalls.find(call => call.method === 'PUT');
      expect(putCall).toBeDefined();
      expect(putCall.url).toContain(testKey);

      fetchCalls.length = 0;

      const data = await s3client.getObject(testKey);
      expect(data).toBe(testContent);

      expect(fetchCalls.length).toBeGreaterThan(0);
      const getCall = fetchCalls.find(call => call.method === 'GET');
      expect(getCall).toBeDefined();
      expect(getCall.url).toContain(testKey);

      await s3client.deleteObject(testKey);
    });

    it('custom fetch can modify request behavior', async () => {
      const customHeaderValue = 'custom-test-value-' + Date.now();
      let customHeaderSent = false;

      const customFetch = async (url, options) => {
        const modifiedOptions = {
          ...options,
          headers: {
            ...options?.headers,
            'X-Custom-Test-Header': customHeaderValue,
          },
        };

        if (modifiedOptions.headers['X-Custom-Test-Header'] === customHeaderValue) {
          customHeaderSent = true;
        }

        return globalThis.fetch(url, modifiedOptions);
      };

      const s3client = new S3mini({
        accessKeyId: bucket.accessKeyId,
        secretAccessKey: bucket.secretAccessKey,
        endpoint: bucket.endpoint,
        region: bucket.region,
        fetch: customFetch,
      });

      const exists = await s3client.bucketExists();

      expect(customHeaderSent).toBe(true);
      expect(exists).toBeDefined();
    });

    it('custom fetch can implement retry logic', async () => {
      let attemptCount = 0;
      const maxRetries = 2;

      const retryingFetch = async (url, options) => {
        for (let i = 0; i <= maxRetries; i++) {
          attemptCount++;
          try {
            const response = await globalThis.fetch(url, options);
            if (response.ok || i === maxRetries) {
              return response;
            }
            await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, i)));
          } catch (error) {
            if (i === maxRetries) {
              throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, i)));
          }
        }
      };

      const s3client = new S3mini({
        accessKeyId: bucket.accessKeyId,
        secretAccessKey: bucket.secretAccessKey,
        endpoint: bucket.endpoint,
        region: bucket.region,
        fetch: retryingFetch,
      });

      attemptCount = 0;

      const exists = await s3client.bucketExists();

      expect(attemptCount).toBeGreaterThanOrEqual(1);
      expect(exists).toBeDefined();
    });

    it('defaults to globalThis.fetch when no custom fetch provided', async () => {
      const s3client = new S3mini({
        accessKeyId: bucket.accessKeyId,
        secretAccessKey: bucket.secretAccessKey,
        endpoint: bucket.endpoint,
        region: bucket.region,
      });

      expect(s3client._fetch).toBeInstanceOf(Function);

      const exists = await s3client.bucketExists();
      expect(exists).toBeDefined();
    });

    it('custom fetch can log requests for debugging', async () => {
      const requestLog = [];

      const loggingFetch = async (url, options) => {
        const logEntry = {
          timestamp: new Date().toISOString(),
          method: options?.method || 'GET',
          url: url.toString(),
          hasBody: !!options?.body,
        };
        requestLog.push(logEntry);

        return globalThis.fetch(url, options);
      };

      const s3client = new S3mini({
        accessKeyId: bucket.accessKeyId,
        secretAccessKey: bucket.secretAccessKey,
        endpoint: bucket.endpoint,
        region: bucket.region,
        fetch: loggingFetch,
      });

      requestLog.length = 0;

      const testKey = `${KEY_PREFIX}logging-test.txt`;
      await s3client.putObject(testKey, 'test content');
      await s3client.getObject(testKey);
      await s3client.deleteObject(testKey);

      expect(requestLog.length).toBeGreaterThan(0);

      const methods = [...new Set(requestLog.map(log => log.method))];
      expect(methods.length).toBeGreaterThan(1);
      expect(methods).toContain('PUT');
      expect(methods).toContain('GET');
    });
  });
}
