import * as esbuild from 'esbuild';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);

// esbuild 无法静态解析的运行时 require（fastify/ajv 按需加载的助手模块），
// 通过 alias 强制内联进 bundle，保证产物零外部依赖。
const runtimeDeps = [
    'fast-json-stringify/lib/serializer',
    'fast-json-stringify/lib/validator',
    'ajv-formats/dist/formats',
    'ajv/dist/runtime/equal',
    'ajv/dist/runtime/parseJson',
    'ajv/dist/runtime/quote',
    'ajv/dist/runtime/timestamp',
    'ajv/dist/runtime/ucs2length',
    'ajv/dist/runtime/uri',
    'ajv/dist/runtime/validation_error',
];
const alias = Object.fromEntries(runtimeDeps.map((m) => [m, req.resolve(m)]));

await esbuild.build({
    entryPoints: ['src/index.js'],
    outfile: '../src/main/assets/cat-server.cjs',
    bundle: true,
    minify: false,
    write: true,
    charset: 'utf8',
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    alias,
});
console.log('build ok -> src/main/assets/cat-server.cjs');
// 预置依赖由 build-deps.mjs 单独生成（每包 3 文件的精简结构 -> assets/npm/）
