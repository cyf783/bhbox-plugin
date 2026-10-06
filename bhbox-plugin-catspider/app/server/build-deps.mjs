// 预打包 5 个预置依赖为「每包 3 个文件」的精简 node_modules 结构。
// 背景：完整 node_modules 2367 个文件，APK 安装释放极慢；合并后每包仅
// <pkg>.cjs（esbuild bundle 全量代码）+ <pkg>.mjs（ESM wrapper：default + named）+
// <pkg>.json（package.json），共 15 个文件。
//
// 用法: node build-deps.mjs
// 前置: deps/node_modules 已通过 deps/package.json 安装
// 产物: ../src/main/assets/npm/
import * as esbuild from 'esbuild';
import { createRequire } from 'module';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
// 解析基准定位到 deps/（依赖安装位置），确保 req.resolve/pkg json 都从 deps/node_modules 解析
const req = createRequire(join(here, 'deps/package.json'));
const outDir = resolve(here, '../src/main/assets/npm');

const PACKAGES = ['crypto-js', 'lodash', 'hls-parser', 'cheerio', 'node-rsa', 'node-forge', 'axios', 'undici'];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const pkg of PACKAGES) {
    // 1) esbuild 全量 bundle 成单文件 CJS（保留 node 内置模块为外部依赖）
    //    undici 为完整打包（源需要 Agent/ProxyAgent/dispatcher，内置全局未暴露）
    const cjs = join(outDir, `${pkg}.cjs`);
    await esbuild.build({
        entryPoints: [req.resolve(pkg)],
        outfile: cjs,
        bundle: true,
        minify: true,
        platform: 'node',
        target: 'node24',
        format: 'cjs',
        charset: 'utf8',
        logLevel: 'warning',
    });

    // 2) 用 bundle 产物枚举 exports，生成 ESM wrapper（default + named）
    //    与 node 原生 ESM→CJS interop 语义对齐：default = module.exports，
    //    named = module.exports 的全部自有键（原生走 cjs-module-lexer 静态分析，
    //    bundle 后识别不可靠，显式导出反而更稳）。
    const mod = req(cjs);
    // 排除 default 键（如 axios 的 module.exports.default），default 已由 export default mod 覆盖
    const named = Object.keys(mod).filter((k) => k !== 'default');
    // named 导出必须绑定到属性值（mod.MD5），而非 mod 整体；
    // 合法标识符键用 export const，其余（含保留字）用临时变量 + 字符串别名导出
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
        ...named.filter((k) => !isSafeIdent(k)).map((k, i) => `const _e${i} = mod[${JSON.stringify(k)}];\nexport { _e${i} as ${JSON.stringify(k)} };`),
        `export default mod;`,
    ];
    const mjs = join(outDir, `${pkg}.mjs`);
    writeFileSync(mjs, mjsLines.join('\n') + '\n');

    // 3) 精简 package.json：双入口指向我们生成的文件
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
