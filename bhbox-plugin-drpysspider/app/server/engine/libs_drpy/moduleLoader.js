import {readFileSync, existsSync} from 'fs';
import path from "path";
import Module, {createRequire} from 'module';
import axios from 'axios';
// 精简：sync-fetch 已裁剪（远程模块同步 require 不支持，stub 仅在调用时抛错）
import fetchSync from '../stubs/sync-fetch.js';

// bundle 后 import.meta.url 不再指向真实引擎目录，统一以 DS_HOME（启动参数传入的源根目录）为基准：
//  - 裸包：<DS_HOME>/node_modules（assets/npm 部署处）
//  - 相对路径：<DS_HOME>/spider/js（_lib* 本地模块）
function dsHome() {
    return process.env.DS_HOME || process.argv[2] || process.cwd();
}

const LIB_ROOT = path.join(dsHome(), 'spider/js');

// 以 <DS_HOME>/node_modules/noop.js 为锚点创建 require，使裸包能从 assets/npm 解析
const customRequire = createRequire(path.join(dsHome(), 'node_modules', 'noop.js'));

/**
 * Patch Module.prototype.require to handle bundled modules in CJS context
 * This allows native CJS modules (like those loaded via require('./lib.js')) to find
 * bundled dependencies (axios, iconv-lite, etc.) which are exposed on globalThis.
 */
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
    if (id === 'iconv-lite' && globalThis.iconv) return globalThis.iconv;
    if (id === 'axios' && globalThis.axios) return globalThis.axios;
    if (id === 'cheerio' && globalThis.cheerio) return globalThis.cheerio;
    if (id === 'qs' && globalThis.qs) return globalThis.qs;
    if (id === 'crypto-js' && globalThis.CryptoJS) return globalThis.CryptoJS;
    return originalRequire.apply(this, arguments);
};

// 导出 rootRequire
export const rootRequire = (modulePath) => {
    // 处理内置模块或打包模块
    if (modulePath === 'iconv-lite') return globalThis.iconv;
    if (modulePath === 'axios') return globalThis.axios;
    if (modulePath === 'cheerio') return globalThis.cheerio;
    if (modulePath === 'qs') return globalThis.qs;
    if (modulePath === 'crypto-js') return globalThis.CryptoJS;
    if (modulePath === 'fs' && globalThis.fs) return globalThis.fs;
    if (modulePath === 'path' && globalThis.path) return globalThis.path;

    if (modulePath.startsWith('./') || modulePath.startsWith('../')) {
        const absolutePath = path.resolve(LIB_ROOT, modulePath);
        return customRequire(absolutePath);
    }
    return customRequire(modulePath);
};

// 导出 initializeGlobalDollar 函数
export function initializeGlobalDollar() {
    if (globalThis.$) return; // 避免重复初始化

    let currentSandbox = null;

    // 执行模块代码
    function executeModule(js_code, sandbox) {
        const script = `
            (function () {
                try {
                    ${js_code}
                } catch (err) {
                    throw new Error("Error executing module script: " + err.message);
                }
            })();
        `;
        const scriptRunner = new Function('sandbox', `
            with (sandbox) {
                ${script}
            }
        `);
        scriptRunner(sandbox);
        if (!$.exports || Object.keys($.exports).length === 0) {
            throw new Error(`Module did not export anything.`);
        }
        return $.exports;
    }

    // 加载本地模块
    function loadLocalModule(jsm_path) {
        const fullPath = path.join(dsHome(), 'spider/js', jsm_path);
        if (!existsSync(fullPath)) {
            throw new Error(`Module not found: ${fullPath}`);
        }
        const baseName = path.basename(fullPath);
        if (!baseName.startsWith('_lib')) {
            throw new Error(`Invalid module name: ${baseName}. Must start with "_lib".`);
        }
        return readFileSync(fullPath, 'utf8');
    }

    // 加载远程模块
    async function loadRemoteModule(jsm_path) {
        try {
            const response = await axios.get(jsm_path, {
                headers: {'user-agent': 'Mozilla/5.0'},
                timeout: 5000,
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to fetch remote module: ${error.message}`);
        }
    }

    // 初始化 $ 对象
    globalThis.$ = {
        /**
         * 设置当前沙箱
         * @param {Object} sandbox - 沙箱上下文
         */
        setSandbox(sandbox) {
            currentSandbox = sandbox;
        },


        /**
         * 异步加载模块
         * @param {string} jsm_path - 模块路径或网络地址
         * @returns {Promise<any>} - 模块的导出内容
         */
        async import(jsm_path) {
            if (!currentSandbox) throw new Error("No sandbox context set");
            const isURL = /^(https?:)?\/\//.test(jsm_path);
            const js_code = isURL
                ? await loadRemoteModule(jsm_path)
                : loadLocalModule(jsm_path);
            return executeModule(js_code, currentSandbox);
        },

        /**
         * 同步加载模块
         * @param {string} jsm_path - 模块路径或网络地址
         * @returns {any} - 模块的导出内容
         */
        require(jsm_path) {
            if (!currentSandbox) throw new Error("No sandbox context set");
            const isURL = /^(https?:)?\/\//.test(jsm_path);
            const js_code = isURL
                ? fetchSync(jsm_path).text()
                : loadLocalModule(jsm_path);
            return executeModule(js_code, currentSandbox);
        },
    };
}