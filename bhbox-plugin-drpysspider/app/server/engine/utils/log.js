// 精简版：控制台日志（原 utils/log.js 经 pino fastlogger）
import util from 'util';

export const log = (...args) => console.log(util.format(...args));
export const logWarn = (...args) => console.warn(util.format(...args));
export const logError = (...args) => console.error(util.format(...args));

export default {log, logWarn, logError};
