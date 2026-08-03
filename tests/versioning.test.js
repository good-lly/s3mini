'use strict';

/**
 * Unit tests only — mock fetch to pin request/response shapes offline.
 * Real versioning lifecycle runs in provider E2E (`_shared.test.js`) against
 * live buckets (MinIO auto-enables versioning in globalSetup).
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { S3mini } from '../src/S3.ts';

function getFixture(name) {
  return readFileSync(resolve(import.meta.dirname, `fixtures/${name}`), 'utf8');
}

function createMockFetch(handler) {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method || 'GET').toUpperCase();
    return handler(url, method, init);
  };
}

function xmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/xml' },
  });
}

function emptyOk(status = 204) {
  return new Response(null, { status });
}

describe('object versioning', () => {
  const endpoint = 'https://my-bucket.s3.us-east-1.amazonaws.com';
  const baseConfig = {
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    endpoint,
    region: 'us-east-1',
  };

  describe('listObjects with versions: true', () => {
    it('parses ListVersionsResult and returns VersionId / IsLatest', async () => {
      let capturedUrl;
      const s3 = new S3mini({
        ...baseConfig,
        fetch: createMockFetch((url, method) => {
          capturedUrl = url;
          expect(method).toBe('GET');
          return xmlResponse(getFixture('versions-response.xml'));
        }),
      });

      const objects = await s3.listObjects('/', '', undefined, { versions: true });
      expect(objects).toHaveLength(2);
      expect(objects[0].Key).toBe('file1.jpg');
      expect(objects[0].VersionId).toBe('1781648073.939709');
      expect(objects[0].IsLatest).toBe(true);
      expect(objects[1].Key).toBe('file2.mp4');
      expect(objects[1].VersionId).toBe('1781648486.233691');

      const u = new URL(capturedUrl);
      expect(u.searchParams.has('versions')).toBe(true);
      expect(u.searchParams.get('list-type')).toBeNull();
    });

    it('includes delete markers with IsDeleteMarker', async () => {
      const s3 = new S3mini({
        ...baseConfig,
        fetch: createMockFetch(() => xmlResponse(getFixture('versions-with-delete-marker.xml'))),
      });

      const objects = await s3.listObjects('/', 'file1.jpg', undefined, { versions: true });
      expect(objects).toHaveLength(3);

      const latest = objects.find(o => o.IsLatest);
      expect(latest?.VersionId).toBe('v-latest');
      expect(latest?.IsDeleteMarker).toBeUndefined();

      const older = objects.find(o => o.VersionId === 'v-older');
      expect(older?.IsLatest).toBe(false);

      const dm = objects.find(o => o.IsDeleteMarker);
      expect(dm?.VersionId).toBe('v-dm');
      expect(dm?.Size).toBe(0);
    });

    it('paginates with key-marker and version-id-marker', async () => {
      const urls = [];
      let page = 0;
      const s3 = new S3mini({
        ...baseConfig,
        fetch: createMockFetch(url => {
          urls.push(url);
          page += 1;
          if (page === 1) {
            return xmlResponse(getFixture('versions-truncated.xml'));
          }
          return xmlResponse(getFixture('versions-with-delete-marker.xml'));
        }),
      });

      const objects = await s3.listObjects('/', '', undefined, { versions: true });
      expect(page).toBe(2);
      expect(objects.length).toBeGreaterThan(1);

      const second = new URL(urls[1]);
      expect(second.searchParams.get('key-marker')).toBe('file1.jpg');
      expect(second.searchParams.get('version-id-marker')).toBe('v-page1');
    });

    it('listObjectsPaged returns opaque next token in versions mode', async () => {
      const s3 = new S3mini({
        ...baseConfig,
        fetch: createMockFetch(() => xmlResponse(getFixture('versions-truncated.xml'))),
      });

      const page1 = await s3.listObjectsPaged('/', '', 1, undefined, { versions: true });
      expect(page1.objects).toHaveLength(1);
      expect(page1.nextContinuationToken).toBeDefined();
      const token = JSON.parse(page1.nextContinuationToken);
      expect(token.k).toBe('file1.jpg');
      expect(token.v).toBe('v-page1');
    });
  });

  describe('listObjectVersions', () => {
    it('returns only exact key matches with latest flagged', async () => {
      const s3 = new S3mini({
        ...baseConfig,
        fetch: createMockFetch((url, method) => {
          expect(method).toBe('GET');
          const u = new URL(url);
          expect(u.searchParams.has('versions')).toBe(true);
          expect(u.searchParams.get('prefix')).toBe('file1.jpg');
          // Include a sibling key that shares the prefix string to ensure filter
          return xmlResponse(`<?xml version="1.0"?>
<ListVersionsResult>
  <IsTruncated>false</IsTruncated>
  <Version>
    <Key>file1.jpg</Key>
    <VersionId>v2</VersionId>
    <IsLatest>true</IsLatest>
    <LastModified>2026-06-16T22:14:34.000Z</LastModified>
    <Size>100</Size>
    <StorageClass>STANDARD</StorageClass>
  </Version>
  <Version>
    <Key>file1.jpg</Key>
    <VersionId>v1</VersionId>
    <IsLatest>false</IsLatest>
    <LastModified>2026-06-15T10:00:00.000Z</LastModified>
    <Size>90</Size>
    <StorageClass>STANDARD</StorageClass>
  </Version>
  <Version>
    <Key>file1.jpg.backup</Key>
    <VersionId>v-other</VersionId>
    <IsLatest>true</IsLatest>
    <LastModified>2026-06-16T22:14:34.000Z</LastModified>
    <Size>50</Size>
    <StorageClass>STANDARD</StorageClass>
  </Version>
</ListVersionsResult>`);
        }),
      });

      const versions = await s3.listObjectVersions('file1.jpg');
      expect(versions).toHaveLength(2);
      expect(versions.every(v => v.Key === 'file1.jpg')).toBe(true);
      expect(versions.find(v => v.IsLatest)?.VersionId).toBe('v2');
      expect(versions.find(v => !v.IsLatest)?.VersionId).toBe('v1');
    });

    it('rejects empty key', async () => {
      const s3 = new S3mini({ ...baseConfig, fetch: createMockFetch(() => emptyOk()) });
      await expect(s3.listObjectVersions('')).rejects.toThrow(/key must be a non-empty string/);
    });
  });

  describe('copyObject versionId', () => {
    it('appends versionId to x-amz-copy-source', async () => {
      let capturedHeaders;
      const s3 = new S3mini({
        ...baseConfig,
        fetch: createMockFetch((_url, method, init) => {
          expect(method).toBe('PUT');
          capturedHeaders = init.headers;
          return xmlResponse(getFixture('copy-response.xml'));
        }),
      });

      await s3.copyObject('src.jpg', 'dst.jpg', { versionId: 'ver/1+2' });
      const copySource = capturedHeaders['x-amz-copy-source'] || capturedHeaders['X-Amz-Copy-Source'];
      expect(copySource).toContain('/my-bucket/');
      expect(copySource).toContain('src.jpg');
      expect(copySource).toContain('versionId=ver%2F1%2B2');
    });

    it('result carries the new object versionId from the response header', async () => {
      const s3 = new S3mini({
        ...baseConfig,
        fetch: createMockFetch(
          () =>
            new Response(getFixture('copy-response.xml'), {
              status: 200,
              headers: { 'content-type': 'application/xml', 'x-amz-version-id': 'ver-new-1' },
            }),
        ),
      });

      const result = await s3.copyObject('src.jpg', 'dst.jpg', { versionId: 'ver/1+2' });
      expect(result.etag).toBeTruthy();
      expect(result.versionId).toBe('ver-new-1');
    });
  });

  describe('deleteObject / deleteObjects versionId', () => {
    it('sends versionId query on single delete', async () => {
      let capturedUrl;
      const s3 = new S3mini({
        ...baseConfig,
        fetch: createMockFetch((url, method) => {
          capturedUrl = url;
          expect(method).toBe('DELETE');
          return emptyOk(204);
        }),
      });

      const ok = await s3.deleteObject({ key: 'file.jpg', versionId: 'v123' });
      expect(ok).toBe(true);
      const u = new URL(capturedUrl);
      expect(u.pathname.endsWith('/file.jpg') || u.pathname.includes('file.jpg')).toBe(true);
      expect(u.searchParams.get('versionId')).toBe('v123');
    });

    it('still accepts string key without versionId', async () => {
      let capturedUrl;
      const s3 = new S3mini({
        ...baseConfig,
        fetch: createMockFetch(url => {
          capturedUrl = url;
          return emptyOk(204);
        }),
      });

      await s3.deleteObject('plain.txt');
      const u = new URL(capturedUrl);
      expect(u.searchParams.get('versionId')).toBeNull();
    });

    it('includes VersionId in bulk delete XML and maps per-version results', async () => {
      let capturedBody;
      const s3 = new S3mini({
        ...baseConfig,
        fetch: createMockFetch((_url, method, init) => {
          expect(method).toBe('POST');
          capturedBody = init.body;
          return xmlResponse(getFixture('delete-result-versions.xml'));
        }),
      });

      const results = await s3.deleteObjects([
        { key: 'file1.jpg', versionId: 'v1' },
        { key: 'file1.jpg', versionId: 'v2' },
        'other.txt',
      ]);

      expect(capturedBody).toContain('<VersionId>v1</VersionId>');
      expect(capturedBody).toContain('<VersionId>v2</VersionId>');
      expect(capturedBody).toContain('<Key>other.txt</Key>');
      expect(capturedBody).not.toMatch(/other\.txt<\/Key><VersionId>/);
      expect(results).toEqual([true, true, true]);
    });

    it('returns deleteMarker info when versionInfo is true', async () => {
      const s3 = new S3mini({
        ...baseConfig,
        fetch: createMockFetch((_url, method) => {
          expect(method).toBe('DELETE');
          // Real providers (AWS/MinIO) return the new marker's id in x-amz-version-id
          // on a single-object delete, not in x-amz-delete-marker-version-id.
          return new Response(null, {
            status: 204,
            headers: {
              'x-amz-delete-marker': 'true',
              'x-amz-version-id': 'dm-xyz',
            },
          });
        }),
      });

      const info = await s3.deleteObject({ key: 'file.jpg' }, { versionInfo: true });
      expect(info).toEqual({
        key: 'file.jpg',
        deleted: true,
        deleteMarker: true,
        deleteMarkerVersionId: 'dm-xyz',
      });
    });

    it('returns the deleted versionId when a specific version is removed with versionInfo', async () => {
      const s3 = new S3mini({
        ...baseConfig,
        fetch: createMockFetch(
          () => new Response(null, { status: 204, headers: { 'x-amz-version-id': 'v-removed' } }),
        ),
      });

      const info = await s3.deleteObject({ key: 'file.jpg', versionId: 'v-removed' }, { versionInfo: true });
      expect(info).toEqual({ key: 'file.jpg', deleted: true, versionId: 'v-removed' });
    });

    it('maps per-target DeleteObjectResult[] from bulk delete markers', async () => {
      const s3 = new S3mini({
        ...baseConfig,
        fetch: createMockFetch(() => xmlResponse(getFixture('delete-result-markers.xml'))),
      });

      const results = await s3.deleteObjects(
        [{ key: 'file1.jpg' }, { key: 'file2.jpg', versionId: 'v-old-2' }, 'other.txt'],
        { versionInfo: true },
      );

      expect(results).toEqual([
        { key: 'file1.jpg', deleted: true, deleteMarker: true, deleteMarkerVersionId: 'dm-1' },
        { key: 'file2.jpg', deleted: true, versionId: 'v-old-2' },
        { key: 'other.txt', deleted: true },
      ]);
    });
  });

  describe('non-versions list still works', () => {
    it('uses list-type=2 and parses ListBucketResult', async () => {
      let capturedUrl;
      const s3 = new S3mini({
        ...baseConfig,
        fetch: createMockFetch(url => {
          capturedUrl = url;
          return xmlResponse(getFixture('list-response.xml'));
        }),
      });

      const objects = await s3.listObjects();
      expect(objects).toHaveLength(3);
      expect(objects[0].VersionId).toBeUndefined();
      const u = new URL(capturedUrl);
      expect(u.searchParams.get('list-type')).toBe('2');
      expect(u.searchParams.has('versions')).toBe(false);
    });
  });

  describe('setBucketVersioning / getBucketVersioning (request shape)', () => {
    it('PUTs VersioningConfiguration with Status', async () => {
      let capturedUrl;
      let capturedBody;
      let capturedMethod;
      const s3 = new S3mini({
        ...baseConfig,
        fetch: createMockFetch((url, method, init) => {
          capturedUrl = url;
          capturedMethod = method;
          capturedBody = init.body;
          return emptyOk(200);
        }),
      });

      await expect(s3.setBucketVersioning('Enabled')).resolves.toBe(true);
      expect(capturedMethod).toBe('PUT');
      expect(new URL(capturedUrl).searchParams.has('versioning')).toBe(true);
      expect(capturedBody).toContain('<Status>Enabled</Status>');
    });

    it('parses getBucketVersioning status', async () => {
      const s3 = new S3mini({
        ...baseConfig,
        fetch: createMockFetch(() =>
          xmlResponse(
            '<?xml version="1.0"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>',
          ),
        ),
      });
      await expect(s3.getBucketVersioning()).resolves.toBe('Enabled');
    });
  });
});
