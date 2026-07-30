import type { SnapConfig } from '@metamask/snaps-cli';
import { resolve } from 'node:path';

const config: SnapConfig = {
  input: resolve(__dirname, 'src/index.tsx'),
  server: {
    port: 8080,
  },
};

export default config;
