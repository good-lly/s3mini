'use strict';

import { S3mini } from '../dist/index.mjs';

const dummyCreds = {
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
};

const extractBucket = endpoint => {
  const s3 = new S3mini({ ...dummyCreds, endpoint });
  return s3.bucketName;
};

describe('_extractBucketName', () => {
  describe('path-style URLs', () => {
    it('localhost with port and path', () => {
      expect(extractBucket('http://localhost:9002/core-s3-dev-local')).toBe('core-s3-dev-local');
    });

    it('IP address with path', () => {
      expect(extractBucket('http://37.205.15.248/test-bucket')).toBe('test-bucket');
    });

    it('Backblaze B2 path-style', () => {
      expect(extractBucket('https://s3.eu-central-003.backblazeb2.com/core-s3-dev-local')).toBe('core-s3-dev-local');
    });

    it('AWS path-style', () => {
      expect(extractBucket('https://s3.us-east-1.amazonaws.com/my-bucket')).toBe('my-bucket');
    });

    it('Google Cloud Storage path-style', () => {
      expect(extractBucket('https://storage.googleapis.com/my-bucket')).toBe('my-bucket');
    });

    it('Oracle OCI path-style', () => {
      expect(
        extractBucket(
          'https://axch456z7gno.compat.objectstorage.eu-amsterdam-1.oraclecloud.com/tears-of-capitalism',
        ),
      ).toBe('tears-of-capitalism');
    });

    it('Cloudflare R2 path-style', () => {
      expect(
        extractBucket('https://467f67331a1542e9bc2c9db1f870d89a.r2.cloudflarestorage.com/core-s3-dev-local'),
      ).toBe('core-s3-dev-local');
    });
  });

  describe('virtual-hosted-style URLs', () => {
    it('Hetzner object storage', () => {
      expect(extractBucket('https://s3mini.fsn1.your-objectstorage.com')).toBe('s3mini');
    });

    it('AWS virtual-hosted (no region)', () => {
      expect(extractBucket('https://my-bucket.s3.amazonaws.com')).toBe('my-bucket');
    });

    it('AWS virtual-hosted (with region)', () => {
      expect(extractBucket('https://my-bucket.s3.us-east-1.amazonaws.com')).toBe('my-bucket');
    });

    it('DigitalOcean Spaces', () => {
      expect(extractBucket('https://my-bucket.nyc3.digitaloceanspaces.com')).toBe('my-bucket');
    });

    it('Cloudflare R2', () => {
      expect(extractBucket('https://bucket.account-id.r2.cloudflarestorage.com')).toBe('bucket');
    });

    it('Scaleway', () => {
      expect(extractBucket('https://s3mini-test.s3.nl-ams.scw.cloud')).toBe('s3mini-test');
    });
  });

  describe('edge cases (no bucket extractable)', () => {
    it('localhost without path returns empty string', () => {
      expect(extractBucket('http://localhost:9000')).toBe('');
    });

    it('IP address without path returns empty string', () => {
      expect(extractBucket('http://192.168.1.1')).toBe('');
    });

    it('two-label hostname without path returns empty string', () => {
      expect(extractBucket('https://example.com')).toBe('');
    });
  });
});
