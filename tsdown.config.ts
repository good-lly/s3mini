import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts'],
  dts: true,
  clean: true,
  exports: true, // This set the exports field in package.json to point to the generated files
});
