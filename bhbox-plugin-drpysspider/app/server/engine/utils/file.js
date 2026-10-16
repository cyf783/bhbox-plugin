// 精简版：原 utils/file.js 依赖 config/parses.conf、spider/js、jx 目录与 sites-map，
// 设备端均不存在。仅保留引擎实际消费的导出：
//   - req_extend_code / es6_extend_code（?raw 由 esbuild 文本内联）
//   - pathLib（数据读写落到 DS_HOME/data）
//   - getParsesDict / executeParse / getSitesMap 的空实现
import path from 'path';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import reqExtendCode from '../libs_drpy/req-extend.js?raw';
import es6ExtendCode from '../libs_drpy/es6-extend.js?raw';

export const req_extend_code = reqExtendCode;
export const es6_extend_code = es6ExtendCode;

export function getSitesMap() {
    return {};
}

export function getParsesDict() {
    return [];
}

export function executeParse(name, host, url) {
    return [false, url];
}

function homeDir() {
    return process.env.DS_HOME || process.argv[2] || process.cwd();
}

export const pathLib = {
    basename: path.basename,
    extname: path.extname,
    readFile(filename) {
        const p = path.join(homeDir(), 'data', filename);
        if (!existsSync(p)) return '';
        try { return readFileSync(p, 'utf8'); } catch (e) { return ''; }
    },
    writeFile(filename, text) {
        try {
            const p = path.join(homeDir(), 'data', filename);
            mkdirSync(path.dirname(p), {recursive: true});
            writeFileSync(p, text, 'utf8');
            return true;
        } catch (e) { return false; }
    },
    readLib() {
        return '';
    },
};

globalThis.pathLib = pathLib;
globalThis.executeParse = executeParse;
