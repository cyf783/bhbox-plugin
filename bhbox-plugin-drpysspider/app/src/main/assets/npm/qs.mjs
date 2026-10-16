import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mod = require('./qs.cjs');
export const formats = mod["formats"];
export const parse = mod["parse"];
export const stringify = mod["stringify"];
export default mod;
