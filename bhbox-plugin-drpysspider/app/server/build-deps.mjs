// 预打包预置源依赖为「每包 3 个文件」的精简 node_modules 结构（沿用 catspider 方案）。
// 用法: node build-deps.mjs（前置: deps/ 下 npm install 完成）
// 产物: ../src/main/assets/npm/<pkg>.{cjs,mjs,json}
import * as esbuild from 'esbuild';
import {createRequire} from 'module';
import {mkdirSync, writeFileSync, rmSync} from 'fs';
import {join, resolve, dirname} from 'path';
import {fileURLToPath} from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(join(here, 'deps/package.json'));
const outDir = resolve(here, '../src/main/assets/npm');

const PACKAGES = [
    'cheerio', 'crypto-js', 'axios', 'qs', 'iconv-lite',
    'lodash', 'dayjs', 'ws', 'node-forge', 'hls-parser',
];

rmSync(outDir, {recursive: true, force: true});
mkdirSync(outDir, {recursive: true});

for (const pkg of PACKAGES) {
    const cjs = join(outDir, `${pkg}.cjs`);
    await esbuild.build({
        entryPoints: [req.resolve(pkg)],
        outfile: cjs,
        bundle: true,
        minify: true,
        platform: 'node',
        target: 'node20',
        format: 'cjs',
        charset: 'utf8',
        logLevel: 'warning',
    });

    const mod = req(cjs);
    const named = Object.keys(mod).filter((k) => k !== 'default');
    const isSafeIdent = (k) => {
        try {
            new Function(`const {${k}} = 1;`);
            return true;
        } catch {
            return false;
        }
    };
    const mjsLines = [
        `import { createRequire } from 'node:module';`,
        `const require = createRequire(import.meta.url);`,
        `const mod = require('./${pkg}.cjs');`,
        ...named.filter(isSafeIdent).map((k) => `export const ${k} = mod[${JSON.stringify(k)}];`),
        ...named.filter((k) => !isSafeIdent).map((k, i) => `const _e${i} = mod[${JSON.stringify(k)}];\nexport { _e${i} as ${JSON.stringify(k)} };`),
        `export default mod;`,
    ];
    writeFileSync(join(outDir, `${pkg}.mjs`), mjsLines.join('\n') + '\n');

    const json = {
        name: pkg,
        version: req(`${pkg}/package.json`).version,
        main: `./${pkg}.cjs`,
        exports: {
            '.': {
                import: `./${pkg}.mjs`,
                require: `./${pkg}.cjs`,
            },
        },
    };
    writeFileSync(join(outDir, `${pkg}.json`), JSON.stringify(json, null, 2));
    console.log(`${pkg}: bundle ok, ${named.length} named exports`);
}
console.log('deps ok -> src/main/assets/npm');
