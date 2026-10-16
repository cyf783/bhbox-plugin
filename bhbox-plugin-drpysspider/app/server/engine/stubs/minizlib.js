// minizlib 精简替代：API 与 node 内置 zlib 对齐（Gzip/Gunzip/Deflate/Inflate + 同步方法）
export {
    Gzip, Gunzip, Deflate, Inflate,
    gzip, gunzip, deflate, inflate,
    gzipSync, gunzipSync, deflateSync, inflateSync,
} from 'zlib';
