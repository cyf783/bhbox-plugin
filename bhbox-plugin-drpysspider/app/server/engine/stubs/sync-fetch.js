// sync-fetch 空桩：moduleLoader 的 $.require 仅对远程模块同步拉取时使用，已不支持
export default function syncFetch() {
    throw new Error('远程模块同步 require(sync-fetch) 已裁剪，请使用 await $.import()');
}
