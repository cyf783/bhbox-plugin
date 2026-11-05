const esbuild = require('esbuild');
const path = require('node:path');

// lx-server 单文件 bundle：vendor musicSdk 的外部依赖走 alias（needle/tunnel/socks 用自写 shim）
const alias = {
  needle: path.resolve(__dirname, 'src/vendor/shims/needle.js'),
  tunnel: path.resolve(__dirname, 'src/vendor/shims/proxies.js'),
  'socks-proxy-agent': path.resolve(__dirname, 'src/vendor/shims/socks-proxy-agent.js'),
};

esbuild.build({
    entryPoints: ['src/index.js'],
    outfile: '../src/main/assets/lx-server.cjs',
    bundle: true,
    minify: false,
    write: true,
    charset: 'utf8',
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    alias,
}).then(() => console.log('build ok -> src/main/assets/lx-server.cjs'));
