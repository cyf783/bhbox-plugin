// 引擎前奏：在导入 drpyS 之前，把 UMD 库挂到 globalThis。
// 等价于 drpy-node 官方 run-bundle.cjs 的 loadUmdLib/loadScript 预加载段——
// drpyCustom/crypto-util/htmlParser 等模块在运行时以裸标识符（pako/CryptoJS/JSONPath…）
// 访问这些库，UMD 在 CJS bundle 内只会挂到 exports，故必须在此显式注入全局。
import {createRequire} from 'module';

import cryptoJsCode from './libs_drpy/crypto-js.js?raw';
import pakoCode from './libs_drpy/pako.min.js?raw';
import jsEncryptCode from './libs_drpy/jsencrypt.js?raw';
import jinjaCode from './libs_drpy/jinja.js?raw';
import json5Code from './libs_drpy/_dist/json5.js?raw';
import nodeRsaCode from './libs_drpy/_dist/node-rsa.js?raw';
import gb18030Code from './libs_drpy/_dist/gb18030.js?raw';
import jsonPathCode from './libs_drpy/jsonpathplus.min.js?raw';
import randomUaCode from './utils/random-http-ua.js?raw';

// CJS bundle 中 import.meta.url 为 undefined，改用 __filename 作为 require 解析锚点
const anchor = (typeof import.meta !== 'undefined' && import.meta.url) || ('file://' + __filename);
const rootRequire = createRequire(anchor);

function loadUmd(code, name) {
    const module = {exports: {}};
    // eslint-disable-next-line no-new-func
    new Function('exports', 'module', 'require', 'globalThis', code)(
        module.exports, module, rootRequire, globalThis
    );
    if (globalThis[name]) return;
    if (module.exports[name]) globalThis[name] = module.exports[name];
    else if (module.exports.default) globalThis[name] = module.exports.default;
    else if (Object.keys(module.exports).length > 0) globalThis[name] = module.exports;
}

function loadScript(code) {
    // 不传 exports/module，强制 UMD 走 globalThis 分支
    // eslint-disable-next-line no-new-func
    new Function('require', 'globalThis', 'exports', 'module', code)(
        rootRequire, globalThis, undefined, undefined
    );
}

loadUmd(cryptoJsCode, 'CryptoJS');
loadUmd(pakoCode, 'pako');
loadUmd(jsEncryptCode, 'JSEncrypt');
loadUmd(jinjaCode, 'jinja');
loadUmd(json5Code, 'JSON5');
loadUmd(nodeRsaCode, 'NODERSA');
loadUmd(gb18030Code, 'gbkTool');
loadUmd(jsonPathCode, 'JSONPath');
loadScript(randomUaCode);            // globalThis.randomUa
