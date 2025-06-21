'use strict';

import { s3mini } from '../dist/S3mini.js';
import * as dotenv from 'dotenv';
dotenv.config({ debug: false });

// get all process.env variable that starts with "BUCKET_ENV_"
const buckets = Object.keys(process.env).filter(key => key.startsWith('BUCKET_ENV_'));

// create an array of objects with the following properties: provider, accessKeyId, secretAccessKey, region, endpoint
const bucketEnv = buckets.map(bucket => {
  const bucketVars = process.env[bucket].split(',');
  return {
    provider: bucketVars[0],
    accessKeyId: bucketVars[1],
    secretAccessKey: bucketVars[2],
    endpoint: bucketVars[3],
    region: bucketVars[4],
  };
});

// list all providers
const providers = bucketEnv.map(bucket => bucket.provider);
console.log('Configured providers:', providers);

(async () => {
  const s3client = new s3mini(bucketEnv[0]);
  console.log('s3mini instance:', bucketEnv[0], s3client);

  // Head bucket - check if the bucket exists
  try {
    const bucketExists = await s3client.bucketExists();
    console.log(`Bucket exists: ${bucketExists}`);

    if (bucketExists) {
      const fileContent = 'Hello, World!';
      const key = 'example.txt';
      const response = await s3client.putObject(key, fileContent);
      console.log(`File uploaded successfully: ${response.status === 200}`);

      if (response.status === 200) {
        const respText = await s3client.getObject(key);
        console.log(`File content: ${respText}`);
        if (respText !== fileContent) {
          console.error('File content does not match expected content.');
        } else {
          console.log('File content matches expected content.');
        }
      }

      for (let i = 0; i < 5; i++) {
        const key = `example-${i}.txt`;
        const response = await s3client.putObject(key, `Hello, World! ${i}`);
        console.log(`File ${key} uploaded successfully: ${response.status === 200}`);
      }
      const listResponse = await s3client.listObjects();
      const keyArray = [];
      console.log('Files in bucket:');
      listResponse.forEach(file => {
        console.log(`- ${file.key}`);
        keyArray.push(file.key);
      });
      const deleteResponse = await s3client.deleteObjects(keyArray);
      console.log(`Files deleted: ${deleteResponse}`);
      const listAfterDelete = await s3client.listObjects();
      console.log('Files after deletion:');
      listAfterDelete.forEach(file => {
        console.log(`- ${file.key}`);
      });
    }
  } catch (error) {
    console.error('Error checking bucket existence:', error);
  }
})();
