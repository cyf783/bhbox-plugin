// P1 验收夹具：验证源内 require('cheerio') 能从 DS_HOME/node_modules 解析到预置依赖
var rule = {
    title: '裸包依赖测试',
    host: 'https://example.com',
    class_name: '测试',
    class_url: 'test',
    一级: async function () {
        const cheerio = require('cheerio');
        const html = '<ul><li><a href="/a">甲</a></li><li><a href="/b">乙</a></li></ul>';
        const $ = cheerio.load(html);
        const list = [];
        $('li a').each(function (_, a) {
            list.push({vod_id: $(a).attr('href'), vod_name: $(a).text()});
        });
        return list;
    }
};
