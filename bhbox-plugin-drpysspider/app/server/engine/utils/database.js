// 空桩：node-sqlite3-wasm 已裁剪。
// ds 源的 setItem/getItem 实际走 drpyInject 内基于 local/js_<key> 文件的 globalThis.local，
// 此处仅为 drpyS 动态 import('../utils/database.js') 的 catch 提供安静失败路径。
export const database = null;
export const DataBase = null;
export default null;
