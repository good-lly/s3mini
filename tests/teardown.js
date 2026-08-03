'use strict';

import * as dotenv from 'dotenv';
dotenv.config();

import { join } from 'path';
import { composeDown } from './docker.js';
import { purgeObjectVersions } from './setup.js';

const composeFiles = {
  minio: join(process.cwd(), 'tests', 'compose.minio.yaml'),
  garage: join(process.cwd(), 'tests', 'compose.garage.yaml'),
  // ceph: join(process.cwd(), 'tests', 'compose.ceph.yaml'),
};

const bucketConfigs = Object.keys(process.env)
  .filter(k => k.startsWith('BUCKET_ENV_'))
  .map(k => {
    const [provider, accessKeyId, secretAccessKey, endpoint, region] = process.env[k].split(',');
    return { provider, accessKeyId, secretAccessKey, endpoint, region };
  });

export default async () => {
  for (const cfg of bucketConfigs) {
    const composeFile = composeFiles[cfg.provider];
    if (!composeFile) continue; // ignore unknown providers

    console.log(`⏬  stopping ${cfg.provider} …`);
    await composeDown(composeFile); // `docker compose -f … down`
  }

  // Reclaim the version debris this run left on the persistent MicroCeph bucket. globalSetup's
  // purge reclaims what accumulated before the run; this mirrors it at run-end so superseded
  // versions and delete markers do not survive into the next run. Like the setup purge it stays off
  // jest's per-test clock — see purgeObjectVersions() in setup.js for the timeout rationale.
  const ceph = bucketConfigs.find(cfg => cfg.provider === 'ceph');
  if (ceph) {
    await purgeObjectVersions(ceph);
  }
};
