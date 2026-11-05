// 临时调试：手动解密 wbd 响应（测试后删除）
const crypto = require('node:crypto');
const key = Buffer.from([112, 87, 39, 61, 199, 250, 41, 191, 57, 68, 45, 114, 221, 94, 140, 228], 'binary');
(async () => {
  const key = Buffer.from([112, 87, 39, 61, 199, 250, 41, 191, 57, 68, 45, 114, 221, 94, 140, 228], 'binary');
  async function tryReq(label, reqBody) {
    const data = Buffer.from(JSON.stringify(reqBody));
    const time = Date.now();
    const cipher = crypto.createCipheriv('aes-128-ecb', key, '');
    const encodeData = Buffer.concat([cipher.update(data), cipher.final()]).toString('base64');
    const sign = crypto.createHash('md5').update('y67sprxhhpws' + encodeData + time).digest('hex').toUpperCase();
    const fullUrl = `https://wbd.kuwo.cn/api/bd/bang/bang_info?data=${encodeURIComponent(encodeData)}&time=${time}&appId=y67sprxhhpws&sign=${sign}`;
    const res = await fetch(fullUrl, { headers: { 'User-Agent': 'kwplayer_ar_9.2.2.1_apk.urlinside.cn.apk' } });
    const body = await res.text();
    try {
      const raw = Buffer.from(decodeURIComponent(body), 'base64');
      const d = crypto.createDecipheriv('aes-128-ecb', key, '');
      const j = JSON.parse(Buffer.concat([d.update(raw), d.final()]).toString());
      console.log(label, '→ code:', j.code, '| data keys:', Object.keys(j.data || {}), '| musiclist:', j.data && j.data.musiclist && j.data.musiclist.length);
    } catch (e) { console.log(label, '→ decrypt ERR:', e.message, '| body head:', body.slice(0, 50)); }
  }
  await tryReq('id=kw__93', { uid: '', devId: '', sFrom: 'kuwo_sdk', user_type: 'AP', carSource: 'kwplayercar_ar_6.0.1.0_apk_keluze.apk', id: 'kw__93', pn: 0, rn: 30 });
  await tryReq('id=93', { uid: '', devId: '', sFrom: 'kuwo_sdk', user_type: 'AP', carSource: 'kwplayercar_ar_6.0.1.0_apk_keluze.apk', id: '93', pn: 0, rn: 30 });
  await tryReq('id=93 rn=100', { uid: '', devId: '', sFrom: 'kuwo_sdk', user_type: 'AP', carSource: 'kwplayercar_ar_6.0.1.0_apk_keluze.apk', id: '93', pn: 0, rn: 100 });
})().catch(e => console.error('FATAL', e.message));
