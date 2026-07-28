'use strict';
import { randomBytes } from 'node:crypto';
import * as dotenv from 'dotenv';
dotenv.config();

import { join } from 'node:path';
import { composeUp, composeUpWait, execDockerCommand } from './docker.js';
import { S3mini } from '../dist/index.mjs';

import { promisify } from 'util';
import { exec } from 'child_process';
const execAsync = promisify(exec);

const composeFiles = {
  minio: join(process.cwd(), 'tests', 'compose.minio.yaml'),
  garage: join(process.cwd(), 'tests', 'compose.garage.yaml'),
  // ceph: join(process.cwd(), 'tests', 'compose.ceph.yaml'),
};

async function cephInit(containerName = 'ceph') {
  console.log('🔧 Initializing Ceph demo container...');

  // The demo container takes time to initialize all services
  console.log('⏳ Waiting 20 seconds for initial startup...');
  await new Promise(resolve => setTimeout(resolve, 20000));

  // For the demo container, we just need to verify S3 is accessible
  let retries = 20;
  while (retries > 0) {
    try {
      // Check if the S3 port responds to HTTP requests
      const response = await execAsync(
        'curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:7480/ || echo "000"',
      );
      const httpCode = response.stdout.trim();

      console.log(`S3 endpoint returned HTTP ${httpCode}`);

      // Any HTTP response (even 403/404) means the service is up
      if ((httpCode !== '000000' && httpCode !== '') || httpCode !== '000') {
        console.log('✅ Ceph S3 service is ready');

        // Optional: Test with a basic S3 operation
        try {
          // This might fail with auth errors, but that's OK - it means S3 is working
          const testCmd = `curl -s -X GET http://localhost:7480/ -H "Host: test-bucket.localhost"`;
          await execAsync(testCmd);
        } catch (e) {
          // Expected to fail with auth error
        }

        return;
      }
    } catch (e) {
      console.log('Check failed:', e.message);
    }

    retries--;
    if (retries > 0) {
      console.log(`⏳ Waiting for S3 endpoint... (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  // If we get here, something is wrong
  try {
    const logs = await execAsync(`docker logs ${containerName} --tail 100 2>&1`);
    console.error('Container logs:', logs.stdout + logs.stderr);
  } catch (e) {}

  throw new Error('Ceph S3 service failed to become ready');
}

async function garageInit(containerName = 'garage') {
  console.log('🔧 Initializing Garage...');

  // The garage config is mounted at /etc/garage.toml in the container
  const configPath = '/etc/garage.toml';

  async function getCurrentLayoutVersion(containerName, cfgPath) {
    const out = await execDockerCommand(containerName, `/garage -c ${cfgPath} layout show | grep -oE '[0-9]+$'`);
    return Number(out.trim());
  }
  async function ensureBucketExists(container, cfgPath, bucketName) {
    try {
      await execDockerCommand(container, `/garage -c ${cfgPath} bucket info ${bucketName}`);
      console.log(`ℹ️  Bucket ${bucketName} already exists – skipping creation`);
    } catch (e) {
      // garage throws “Bucket … not found” when the bucket is absent
      if (/Bucket .* not found/.test(e.stderr || '')) {
        await execDockerCommand(container, `/garage -c ${cfgPath} bucket create ${bucketName}`); // create once
        console.log(`✅ Bucket created: ${bucketName}`);
      } else {
        throw e; // genuine failure
      }
    }
  }

  // Wait for container and garage server to be ready
  let retries = 10;
  while (retries > 0) {
    try {
      // Check if garage server is responding
      // IMPORTANT: Using /garage (full path) not just 'garage'
      await execDockerCommand(containerName, `/garage -c ${configPath} status`);
      console.log('✅ Garage server is ready');
      break;
    } catch (error) {
      retries--;
      if (retries === 0) {
        console.error('Final error:', error);
        // Try to get container logs for debugging
        try {
          const logs = await execAsync(`docker logs ${containerName} --tail 50`);
          console.error('Container logs:', logs.stdout || logs.stderr);
        } catch (logError) {
          console.error('Could not fetch container logs:', logError.message);
        }
        throw new Error('Garage server failed to become ready after 10 attempts');
      }
      console.log(`⏳ Waiting for Garage server to be ready... (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  try {
    // 1. Get node ID
    const statusOutput = await execDockerCommand(containerName, `/garage -c ${configPath} status`);

    // Extract node ID from status output
    let nodeId = null;
    const nodeIdRegex = /^([0-9a-f]{16})\s+/m;
    const nodeIdMatch = statusOutput.match(nodeIdRegex);
    if (nodeIdMatch) {
      nodeId = nodeIdMatch[1];
    } else {
      // Try alternative parsing
      const lines = statusOutput.split('\n');

      for (const line of lines) {
        // Look for a line that starts with a 16-character hex string
        const match = line.match(/^([0-9a-f]{16})\s+/);
        if (match) {
          nodeId = match[1];
          break;
        }
      }
    }

    if (!nodeId) {
      console.error('Could not parse node ID from status output');
      throw new Error('Could not find node ID in garage status output');
    }
    console.log(`📍 Found node ID: ${nodeId}`);

    const current = await getCurrentLayoutVersion(containerName, configPath);
    const nextVersion = current + 1;

    // 2. Assign layout
    await execDockerCommand(containerName, `/garage -c ${configPath} layout assign -z dc1 -c 1G ${nodeId}`);
    console.log('✅ Layout assigned');

    // 3. Apply layout
    if (current === 0) {
      await execDockerCommand(containerName, `/garage -c ${configPath} layout apply --version ${nextVersion}`);
      console.log(`✅ Layout applied (v${nextVersion})`);
    } else {
      console.log(`ℹ️  Layout already at v${current}, skipping apply`);
    }
    // 4. Create bucket
    const bucketName = 'test-bucket';
    await ensureBucketExists(containerName, configPath, bucketName);
    console.log(`✅ Bucket exists: ${bucketName}`);

    // 5. Create key
    const keyName = `test-key-${randomBytes(6).toString('hex')}`;
    const keyOutput = await execDockerCommand(containerName, `/garage -c ${configPath} key create ${keyName}`);

    // Extract key ID and secret from output
    const keyIdMatch = keyOutput.match(/Key ID:\s+(\S+)/);
    const secretKeyMatch = keyOutput.match(/Secret key:\s+(\S+)/);

    if (!keyIdMatch || !secretKeyMatch) {
      console.log('Key output:', keyOutput);
      throw new Error('Could not extract key credentials from output');
    }

    const keyId = keyIdMatch[1];
    const secretKey = secretKeyMatch[1];

    console.log(`✅ Key created`);

    // 6. Allow key to access bucket
    await execDockerCommand(
      containerName,
      `/garage -c ${configPath} bucket allow --read --write --owner ${bucketName} --key ${keyName}`,
    );
    console.log(`✅ Key granted access to bucket ${bucketName}`);

    // Store credentials in environment for tests to use
    process.env.BUCKET_ENV_GARAGE = `garage,${keyId},${secretKey},http://localhost:9000/test-bucket,garage`;

    return { keyId, secretKey, bucketName };
  } catch (error) {
    console.error('❌ Failed to initialize Garage:', error);
    throw error;
  }
}

const bucketConfigs = Object.keys(process.env)
  .filter(k => k.startsWith('BUCKET_ENV_'))
  .map(k => {
    const [provider, accessKeyId, secretAccessKey, endpoint, region] = process.env[k].split(',');
    return { provider, accessKeyId, secretAccessKey, endpoint, region };
  });

/**
 * Ensure the MinIO bucket exists and has versioning enabled so E2E versioning
 * tests exercise a real ListObjectVersions / versioned copy-delete path.
 */
async function minioEnableVersioning(cfg) {
  const s3 = new S3mini({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    endpoint: cfg.endpoint,
    region: cfg.region || 'us-east-1',
  });

  // Bucket may not exist yet on a fresh volume
  try {
    const exists = await s3.bucketExists();
    if (!exists) {
      await s3.createBucket();
      console.log(`✅ MinIO bucket created for versioning tests`);
    }
  } catch (err) {
    // createBucket can 409 if it already exists; continue
    console.warn(`MinIO bucketExists/createBucket: ${err.message || err}`);
  }

  const ok = await s3.setBucketVersioning('Enabled');
  if (!ok) {
    throw new Error('Failed to enable MinIO bucket versioning');
  }
  const status = await s3.getBucketVersioning();
  console.log(`✅ MinIO bucket versioning: ${status}`);
}

/**
 * Reclaim non-current object versions and delete markers left on a versioned bucket.
 *
 * Every cleanup in the suite deletes by key, which on a versioned bucket only adds a delete marker
 * — the old versions stay in the bucket index and listObjects() stops showing them, so the debris
 * is invisible and grows by ~2 entries per key per CI run until the provider starts answering the
 * parallel upload tests with 503 SlowDown.
 *
 * This runs in globalSetup rather than a beforeAll hook on purpose: on a bucket that has been
 * accumulating for a while it is tens of thousands of deletes, which would blow jest's per-test
 * timeout. globalSetup is not on that clock.
 */
async function purgeObjectVersions(cfg) {
  const s3 = new S3mini({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    endpoint: cfg.endpoint,
    region: cfg.region,
  });

  let listed;
  try {
    listed = await s3.listObjects('/', '', undefined, { versions: true });
  } catch (err) {
    // Providers without ListObjectVersions (R2 answers 501, garage has no versioning) have nothing
    // to purge — anything else is worth seeing in the log rather than swallowing.
    console.warn(`🧹 ${cfg.provider}: version purge skipped — ${err.message || err}`);
    return;
  }

  const targets = (listed ?? [])
    .filter(o => o.VersionId && o.VersionId !== 'null')
    .map(o => ({ key: o.Key, versionId: o.VersionId }));
  if (targets.length === 0) return;

  await s3.deleteObjects(targets);
  console.log(`🧹 ${cfg.provider}: purged ${targets.length} object versions / delete markers`);
}

export default async () => {
  for (const cfg of bucketConfigs) {
    const composeFile = composeFiles[cfg.provider];
    if (!composeFile) continue;
    console.log(`⏫  starting ${cfg.provider} image …`);
    switch (cfg.provider) {
      case 'minio':
        process.env.MINIO_ROOT_USER = cfg.accessKeyId;
        process.env.MINIO_ROOT_PASSWORD = cfg.secretAccessKey;
        await composeUpWait(composeFile);
        await minioEnableVersioning(cfg);
        break;
      case 'garage':
        await composeUp(composeFile);
        break;
      default:
        await composeUp(composeFile);
    }

    if (cfg.provider === 'garage') {
      await garageInit();
    }
    // if (cfg.provider === 'ceph') {
    //   await cephInit();
    // }
  }

  // Re-read the env: garageInit() publishes BUCKET_ENV_GARAGE only once its container is up.
  const configured = Object.keys(process.env)
    .filter(k => k.startsWith('BUCKET_ENV_'))
    .map(k => {
      const [provider, accessKeyId, secretAccessKey, endpoint, region] = process.env[k].split(',');
      return { provider, accessKeyId, secretAccessKey, endpoint, region };
    });
  await Promise.all(configured.map(purgeObjectVersions));
};
