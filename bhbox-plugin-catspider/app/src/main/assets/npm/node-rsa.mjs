import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mod = require('./node-rsa.cjs');
export default mod;
