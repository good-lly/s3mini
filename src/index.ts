'use strict';

import { S3mini } from './S3.js';
import { sanitizeETag, runInBatches } from './utils.js';

// Export the S3 class as default export and named export
export { S3mini, sanitizeETag, runInBatches };
export default S3mini;

// Re-export types
export type {
  S3Config,
  Logger,
  UploadPart,
  CompleteMultipartUploadResult,
  ExistResponseCode,
  ListBucketResponse,
  ListMultipartUploadResponse,
  ErrorWithCode,
} from './types.js';
