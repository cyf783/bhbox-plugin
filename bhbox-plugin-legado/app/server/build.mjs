// esbuild 打包 legado-server → src/main/assets/legado-server.cjs（零外部依赖单文件）
// 用法: npm install && npm run build
// 说明: 引擎自带依赖（cheerio/jsonpath-plus/@xmldom 等，M2 引入）在构建期内联进 bundle，
//       与 catspider 的 assets/npm「每包 3 文件」机制不同——那套机制服务于用户自定义源
//       运行时 require 任意包的场景，本插件引擎代码自包含，无需运行期依赖部署。
import * as esbuild from 'esbuild';

await esbuild.build({
    entryPoints: ['src/index.js'],
    outfile: '../src/main/assets/legado-server.cjs',
    bundle: true,
    minify: false,
    write: true,
    charset: 'utf8',
    format: 'cjs',
    platform: 'node',
    target: 'node24',
});
console.log('build ok -> src/main/assets/legado-server.cjs');
