// 空桩：原 fetchAxios.js 基于 undici（DS_REQ_LIB=0 路径）。
// 设备端强制 DS_REQ_LIB=1 走 axios（见 src/index.js），此模块不会被实际调用。
export function createHttpsInstance() {
    throw new Error('fetch(undici) 请求库已裁剪，请设置 DS_REQ_LIB=1 使用 axios');
}

export const httpsAgent = null;
