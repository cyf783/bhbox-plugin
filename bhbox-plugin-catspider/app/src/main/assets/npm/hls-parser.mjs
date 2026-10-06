import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mod = require('./hls-parser.cjs');
export const parse = mod["parse"];
export const stringify = mod["stringify"];
export const types = mod["types"];
export const getOptions = mod["getOptions"];
export const setOptions = mod["setOptions"];
export default mod;
