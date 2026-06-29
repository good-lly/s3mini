import { readFileSync } from 'fs';
import { resolve } from 'path';

import { parseXml } from '../src/utils';

function getFixture(name) {
  const path = resolve(import.meta.dirname, `fixtures/${name}`);
  return readFileSync(path, 'utf8');
}

describe('parseXml', () => {
  it('handles simple xml', () => {
    const xml = getFixture('copy-response.xml');
    const data = parseXml(xml);

    expect(data).toEqual({
      CopyObjectResult: {
        LastModified: '2009-10-12T17:50:30.000Z',
        ETag: '"9b2cf535f27731c974343645a3985328"',
      },
    });
  });

  it('handles lists', () => {
    const xml = getFixture('list-response.xml');
    const data = parseXml(xml);

    expect(data).toEqual({
      ListBucketResult: {
        Name: 'bucket',
        Prefix: '',
        MaxKeys: '1000',
        IsTruncated: 'false',
        Marker: '',
        Contents: [
          {
            Key: 'file1.jpg',
            LastModified: '2026-06-16T22:14:34.000Z',
            Size: '26702',
            StorageClass: 'STANDARD',
            Owner: {
              DisplayName: 'user',
              ID: 'user',
            },
          },
          {
            Key: 'file2.mp4',
            LastModified: '2026-06-16T22:21:26.000Z',
            Size: '3217865',
            StorageClass: 'STANDARD',
            Owner: {
              DisplayName: 'user',
              ID: 'user',
            },
          },
          {
            Key: 'file3.jpg',
            LastModified: '2026-06-18T15:24:31.000Z',
            Size: '56481',
            StorageClass: 'STANDARD',
            Owner: {
              DisplayName: 'user',
              ID: 'user',
            },
          },
        ],
      },
    });
  });

  it('handles self-closing tags', () => {
    const xml = getFixture('versions-response.xml');
    const data = parseXml(xml);

    expect(data).toEqual({
      ListVersionsResult: {
        Name: 'bucket',
        Prefix: '',
        MaxKeys: '1000',
        IsTruncated: 'false',
        KeyMarker: '',
        VersionIdMarker: '',
        Version: [
          {
            Key: 'file1.jpg',
            IsLatest: 'true',
            VersionId: '1781648073.939709',
            LastModified: '2026-06-16T22:14:34.000Z',
            Size: '26702',
            StorageClass: 'STANDARD',
            Owner: {
              DisplayName: 'user',
              ID: 'user',
            },
          },
          {
            Key: 'file2.mp4',
            IsLatest: 'true',
            VersionId: '1781648486.233691',
            LastModified: '2026-06-16T22:21:26.000Z',
            Size: '3217865',
            StorageClass: 'STANDARD',
            Owner: {
              DisplayName: 'user',
              ID: 'user',
            },
          },
        ],
      },
    });
  });
});
