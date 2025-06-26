import { Hono } from 'hono';
import { S3mini } from '../../../dist/s3mini.js';

const app = new Hono();

app.get('/', c => {
  const s3 = new S3mini({});
  return c.text('Hello Hono!');
});

export default app;
