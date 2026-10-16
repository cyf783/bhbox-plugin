// 引擎引导：必须是入口第一个被求值的模块（ESM 导入按源序深度优先求值），
// 在任何引擎模块读取环境变量之前完成设置。
import process from 'process';

process.env.DS_REQ_LIB = '1';                 // 强制 axios 请求链路（undici 已裁剪）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.DS_HOME = process.argv[2] || process.cwd();
process.chdir(process.env.DS_HOME);
