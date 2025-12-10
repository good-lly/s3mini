'use strict';

import { S3mini, sanitizeETag } from '../dist/s3mini.js';
import * as dotenv from 'dotenv';
dotenv.config({ debug: false });
const configs = process.env['BUCKET_ENV_CLOUDFLARE'].split(',');
// const buckets = Object.keys(process.env).filter(key => key.startsWith('BUCKET_ENV_'));

(async () => {
  const s3client = new S3mini({
    accessKeyId: configs[1],
    secretAccessKey: configs[2],
    endpoint: configs[3],
    region: configs[4],
  });
  console.log('s3mini instance:', s3client);
  try {
    const fileContent = 'Hello, World!';
    const key = 'myobjectname';
    const ssecHeaders = {
      'x-amz-server-side-encryption-customer-algorithm': 'AES256',
      'x-amz-server-side-encryption-customer-key': 'n1TKiTaVHlYLMX9n0zHXyooMr026vOiTEFfT+719Hho=',
      'x-amz-server-side-encryption-customer-key-md5': 'gepZmzgR7Be/1+K1Aw+6ow==',
    };
    const response = await s3client.putObject(key, fileContent, undefined, ssecHeaders);
    console.log(`File uploaded successfully: ${response.status === 200}`);

    const getObjectResponse = await s3client.getObject(key, {}, ssecHeaders);
    console.log(`File content retrieved successfully: ${getObjectResponse !== null}`);
    if (getObjectResponse) {
      console.log('File content:', getObjectResponse);
    }

    // add new object without SSE-C
    const newKey = 'myobjectname2';
    const newResponse = await s3client.putObject(newKey, fileContent);
    console.log(`New file uploaded successfully: ${newResponse.status === 200}`);

    // add new object with SSE-C
    const newSsecHeaders = {
      'x-amz-server-side-encryption-customer-algorithm': 'AES256',
      'x-amz-server-side-encryption-customer-key': 'n1TKiTaVHlYLMX9n0zHXyooMr026vOiTEFfT+719Hho=',
      'x-amz-server-side-encryption-customer-key-md5': 'gepZmzgR7Be/1+K1Aw+6ow==',
    };
    const newSsecResponse = await s3client.putObject(newKey, fileContent, undefined, newSsecHeaders);
    console.log(`New file with SSE-C uploaded successfully: ${newSsecResponse.status === 200}`);

    // list all objects in the bucket
    const listResponse = await s3client.listObjects();
    console.log('List of objects in the bucket:', listResponse);
  } catch (error) {
    console.error('Error checking bucket existence:', error);
  }
})();
