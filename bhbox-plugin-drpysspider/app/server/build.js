import * as esbuild from 'esbuild';
import {createRequire} from 'module';
import {readFileSync} from 'fs';
import {dirname, resolve as pathResolve, normalize} from 'path';
import {fileURLToPath} from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const engineDir = pathResolve(here, 'engine');

// fastify/ajv 运行时按需 require 的助手模块，强制内联（沿用 catspider 方案）
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
// 裁剪掉的 npm 包 → 本地精简桩
Object.assign(alias, {
    'lru-cache': pathResolve(engineDir, 'stubs/lru-cache.js'),
    'minizlib': pathResolve(engineDir, 'stubs/minizlib.js'),
    'simplecc-wasm': pathResolve(engineDir, 'stubs/simplecc.js'),
    'sync-fetch': pathResolve(engineDir, 'stubs/sync-fetch.js'),
});

// 1) ?raw：把 req-extend/es6-extend/UMD 源码以文本内联（引擎需要「读文本注入 vm」语义）
const rawPlugin = {
    name: 'raw-text',
    setup(build) {
        build.onResolve({filter: /\?raw$/}, (args) => ({
            path: pathResolve(dirname(args.importer), args.path.slice(0, -4)),
            namespace: 'raw',
        }));
        build.onLoad({filter: /.*/, namespace: 'raw'}, (args) => ({
            contents: 'export default ' + JSON.stringify(readFileSync(args.path, 'utf8')),
            loader: 'js',
        }));
    },
};

// 2) UMD 库由 prelude.js 统一挂全局，引擎模块内的副作用导入重定向到空模块，避免重复打包
const UMD_FILES = new Set([
    'libs_drpy/crypto-js.js',
    'libs_drpy/pako.min.js',
    'libs_drpy/jsencrypt.js',
    'libs_drpy/jinja.js',
    'libs_drpy/jsonpathplus.min.js',
    'libs_drpy/_dist/node-rsa.js',
    'libs_drpy/_dist/gb18030.js',
    'libs_drpy/_dist/json5.js',
    'utils/random-http-ua.js',
].map((p) => normalize(pathResolve(engineDir, p))));
const emptyStub = pathResolve(engineDir, 'stubs/empty.js');

const umdRedirectPlugin = {
    name: 'umd-redirect',
    setup(build) {
        build.onResolve({filter: /./}, (args) => {
            if (args.path.endsWith('?raw') || !args.importer) return null;
            if (!args.importer.startsWith(engineDir)) return null;
            const candidate = normalize(pathResolve(dirname(args.importer), args.path));
            if (UMD_FILES.has(candidate)) return {path: emptyStub};
            return null;
        });
    },
};

await esbuild.build({
    entryPoints: ['src/index.js'],
    outfile: '../src/main/assets/ds-server.cjs',
    bundle: true,
    minify: false,
    write: true,
    charset: 'utf8',
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    alias,
    plugins: [rawPlugin, umdRedirectPlugin],
});
console.log('build ok -> src/main/assets/ds-server.cjs');
// 预置源依赖由 build-deps.mjs 单独生成（每包 3 文件的精简结构 -> assets/npm/）
