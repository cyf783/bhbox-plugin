// 空桩：puppeteer 无头浏览器已裁剪（drpyS 动态 import 失败会走 catch 分支）
export function puppeteerHelper() {
    throw new Error('puppeteer 已裁剪');
}
