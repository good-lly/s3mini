'use strict';

/**
 * Unit tests only — mock fetch to pin how many part uploads a multipart upload keeps in flight.
 * More than the cap breaks the memory bound on streamed bodies; fewer silently serializes the upload.
 */

import { S3mini } from '../src/S3.ts';

const PART_SIZE = 5;
const PART_COUNT = 10;
const MAX_IN_FLIGHT = 4; // default `concurrency` of the private multipart helpers in S3.ts

const mockedClient = () => {
  const stats = { inFlight: 0, maxInFlight: 0, partNumbers: [], aborted: false };
  const fetch = async (url, init) => {
    const { searchParams } = new URL(url);
    if (init.method === 'DELETE') {
      stats.aborted = true;
      return new Response(null, { status: 204 });
    }
    if (init.method === 'PUT') {
      const partNumber = searchParams.get('partNumber');
      stats.partNumbers.push(Number(partNumber));
      stats.maxInFlight = Math.max(stats.maxInFlight, ++stats.inFlight);
      await new Promise(r => setTimeout(r, 20));
      stats.inFlight--;
      return new Response(null, { status: 200, headers: { etag: `"etag-${partNumber}"` } });
    }
    const xml = searchParams.has('uploads')
      ? '<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>'
      : '<CompleteMultipartUploadResult><ETag>"done"</ETag></CompleteMultipartUploadResult>';
    return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } });
  };
  const s3 = new S3mini({
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    endpoint: 'https://my-bucket.s3.us-east-1.amazonaws.com',
    region: 'us-east-1',
    fetch,
    minPartSize: PART_SIZE,
  });
  return { s3, stats };
};

const bytes = () => new Uint8Array(PART_SIZE * PART_COUNT);

describe('multipart upload concurrency', () => {
  it.each([
    ['Uint8Array', bytes],
    ['Blob', () => new Blob([bytes()])],
    [
      'ReadableStream',
      () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes());
            controller.close();
          },
        }),
    ],
  ])('%s body keeps exactly 4 parts in flight and uploads every part once', async (_, body) => {
    const { s3, stats } = mockedClient();

    const res = await s3.putAnyObject('object.bin', body());

    expect(res.ok).toBe(true);
    expect(stats.maxInFlight).toBe(MAX_IN_FLIGHT);
    expect(stats.partNumbers.sort((a, b) => a - b)).toEqual(Array.from({ length: PART_COUNT }, (_, i) => i + 1));
  });

  it('a failed part is always observed, even when the source stream errors first', async () => {
    const { s3, stats } = mockedClient();
    // Stands in for a part that used up its retries, without waiting out the real backoff.
    s3._uploadPartWithRetry = () => Promise.reject(new Error('part failed'));
    let pulls = 0;
    const failingSource = new ReadableStream({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(new Uint8Array(PART_SIZE)); // a single part, so no race observes its failure
        } else {
          controller.error(new Error('source failed'));
        }
      },
    });

    await expect(s3.putAnyObject('object.bin', failingSource)).rejects.toThrow('source failed');
    expect(stats.aborted).toBe(true);
  });
});
