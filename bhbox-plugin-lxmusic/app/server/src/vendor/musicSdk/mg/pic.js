"use strict";
// 注：原版（lxserver 上游）带 fire-and-forget 重试链， rejection 无人接且 cancelHttp 取自 Promise 必崩；
// 本副本简化为单次尝试，失败直接 reject（封面在本工程中为非阻塞增强）
Object.defineProperty(exports, "__esModule", { value: true });
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const request_1 = require("../../request");
const songId_1 = __importDefault(require("./songId"));
exports.default = {
    async getPicUrl(songId) {
        const requestObj = (0, request_1.httpFetch)(`http://music.migu.cn/v3/api/music/audioPlayer/getSongPic?songId=${songId}`, {
            headers: {
                Referer: 'http://music.migu.cn/v3/music/player/audio?from=migu',
            },
        });
        const { body } = await requestObj.promise;
        if (body.returnCode !== '000000')
            throw new Error('图片获取失败');
        let url = body.largePic || body.mediumPic || body.smallPic;
        if (!/https?:/.test(url))
            url = 'http:' + url;
        return url;
    },
    async getPic(songInfo) {
        const songId = await (0, songId_1.default)(songInfo);
        return this.getPicUrl(songId);
    },
};
