package com.github.tvbox.quickjs.method;

import android.util.Base64;

import com.github.catvod.Init;
import com.github.catvod.net.OkHttp;
import com.github.catvod.utils.UriUtil;
import com.github.tvbox.quickjs.bean.Req;
import com.github.tvbox.quickjs.utils.Connect;
import com.github.tvbox.quickjs.utils.JsLibAsset;
import com.github.tvbox.quickjs.utils.Module;
import com.whl.quickjs.wrapper.JSObject;
import com.whl.quickjs.wrapper.QuickJSContext;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.Key;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.MGF1ParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.PSSParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.zip.Deflater;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;
import java.util.zip.Inflater;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

import okhttp3.Response;

/**
 * drpy3 宿主桥：向 QuickJS 全局注入 __drpy3host 对象（drpy3-shim.js 消费）。
 *
 * 仅承载 JS 层做不了的宿主能力，边界值一律为字符串（网络响应为 JSON 串、
 * 字节流为 base64），规避 wrapper 对 typed array 透传的不确定性：
 *   - req(url, optionsJson)：走 Connect/OkHttp，返回 {code, headers, content} JSON 串
 *   - gzip/gunzip/unzip/deflate/inflate(b64)：java.util.zip 压缩解压
 *   - getProxy(isPublic)：宿主代理地址
 *   - loadAsset(path)：读插件 assets
 */
public class Drpy3Host {

    /** 源地址基：随源相对资产（如央视频 wasm 解密胶水 ./_lib.*.js）的解析基准，由 JsSpider 装载源码时设置 */
    private static volatile String sourceBase;

    public static void setSource(String source) {
        sourceBase = source;
    }

    /** args: path。相对路径先按源地址解析（Module.fetch 支持 http/file/assets），兜底读插件 assets */
    private static Object loadAsset(Object[] args) throws Exception {
        String path = args.length > 0 && args[0] != null ? args[0].toString() : "";
        if (path.isEmpty()) return "";
        if (sourceBase != null && (path.startsWith("./") || path.startsWith("../"))) {
            try {
                String content = Module.get().fetch(UriUtil.resolve(sourceBase, path));
                if (content != null && !content.isEmpty()) return content;
            } catch (Throwable ignored) {
            }
        }
        return JsLibAsset.read(path);
    }

    public static void register(QuickJSContext ctx) {
        JSObject host = ctx.createJSObject();
        host.set("req", args -> req(ctx, args));
        host.set("gzip", args -> zip(args, Mode.GZIP));
        host.set("gunzip", args -> zip(args, Mode.GUNZIP));
        host.set("unzip", args -> zip(args, Mode.GUNZIP));
        host.set("deflate", args -> zip(args, Mode.DEFLATE));
        host.set("inflate", args -> zip(args, Mode.INFLATE));
        host.set("getProxy", args -> getProxy(args));
        host.set("loadAsset", args -> safe(Drpy3Host::loadAsset, args));
        // crypto.subtle 后端（drpy3-shim.js 的 WebCrypto 实现，base64 进出）
        host.set("digest", args -> safe(Drpy3Host::digest, args));
        host.set("aesEnc", args -> safe(a -> aes(a, true), args));
        host.set("aesDec", args -> safe(a -> aes(a, false), args));
        host.set("pbkdf2", args -> safe(Drpy3Host::pbkdf2, args));
        host.set("hmacSign", args -> safe(Drpy3Host::hmacSign, args));
        host.set("rsaGen", args -> safe(Drpy3Host::rsaGen, args));
        host.set("rsaCipher", args -> safe(Drpy3Host::rsaCipher, args));
        host.set("rsaSign", args -> safe(Drpy3Host::rsaSign, args));
        host.set("rsaVerify", args -> safe(Drpy3Host::rsaVerify, args));
        ctx.getGlobalObject().set("__drpy3host", host);
        host.release();
    }

    private static Object req(QuickJSContext ctx, Object[] args) {
        if (args.length < 2 || args[0] == null) return "{}";
        try {
            Req req = Req.objectFrom(args[1].toString());
            Response res = Connect.to(args[0].toString(), req).execute();
            return Connect.success(ctx, req, res).stringify();
        } catch (Throwable e) {
            return Connect.error(ctx).stringify();
        }
    }

    private enum Mode {GZIP, GUNZIP, DEFLATE, INFLATE}

    private static Object zip(Object[] args, Mode mode) {
        if (args.length < 1 || args[0] == null) return "";
        try {
            byte[] in = Base64.decode(args[0].toString(), Base64.DEFAULT);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            if (mode == Mode.GZIP) {
                GZIPOutputStream gos = new GZIPOutputStream(bos);
                gos.write(in);
                gos.close();
            } else if (mode == Mode.DEFLATE) {
                Deflater deflater = new Deflater();
                deflater.setInput(in);
                deflater.finish();
                byte[] buffer = new byte[4096];
                while (!deflater.finished()) bos.write(buffer, 0, deflater.deflate(buffer));
                deflater.end();
            } else if (mode == Mode.GUNZIP) {
                GZIPInputStream gis = new GZIPInputStream(new ByteArrayInputStream(in));
                byte[] buffer = new byte[4096];
                int len;
                while ((len = gis.read(buffer)) != -1) bos.write(buffer, 0, len);
                gis.close();
            } else {
                Inflater inflater = new Inflater(true);
                inflater.setInput(in);
                pump(inflater, bos);
                inflater.end();
            }
            return Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
        } catch (Throwable e) {
            return "";
        }
    }

    private static void pump(Inflater inflater, ByteArrayOutputStream bos) throws Exception {
        byte[] buffer = new byte[4096];
        while (!inflater.finished() && inflater.inflate(buffer) > 0) bos.write(buffer);
    }

    private static Object getProxy(Object[] args) {
        boolean isPublic = args.length > 0 && args[0] instanceof Number && ((Number) args[0]).intValue() == 1;
        return Init.getServerAddress(!isPublic) + "proxy?do=js";
    }

    // ═══ crypto.subtle 后端（WebCrypto 语义，drpy3-shim.js 调用） ═══

    private interface ThrowingFn {
        Object apply(Object[] args) throws Exception;
    }

    /** 桥方法异常需转为 JS 异常抛出，静默返回空值会掩盖解密失败 */
    private static Object safe(ThrowingFn fn, Object[] args) {
        try {
            return fn.apply(args);
        } catch (Throwable e) {
            String msg = e.getMessage() == null ? e.toString() : e.getMessage();
            throw new RuntimeException(msg, e);
        }
    }

    private static byte[] unb64(Object o) {
        return o == null ? new byte[0] : Base64.decode(o.toString(), Base64.DEFAULT);
    }

    private static String b64(byte[] data) {
        return Base64.encodeToString(data, Base64.NO_WRAP);
    }

    /** WebCrypto hash 名（"SHA-256"）归一化；MGF1ParameterSpec/JCE digest 均接受带连字符形式 */
    private static String normHash(Object o) {
        String hash = o == null || o.toString().isEmpty() ? "SHA-1" : o.toString().toUpperCase().trim();
        return hash.equals("SHA") ? "SHA-1" : hash;
    }

    private static String jcaHash(Object o) {
        return normHash(o).replace("-", "");
    }

    private static Object digest(Object[] args) throws Exception {
        return b64(MessageDigest.getInstance(normHash(args[0])).digest(unb64(args[1])));
    }

    /** args: alg("AES-GCM"|"AES-CBC"|"AES-ECB"), key, iv, data, aad, tagBits；GCM 密文与 WebCrypto 一致为 ct||tag */
    private static Object aes(Object[] args, boolean encrypt) throws Exception {
        SecretKey key = new SecretKeySpec(unb64(args[1]), "AES");
        Cipher cipher;
        if (args[0].toString().contains("GCM")) {
            int tagBits = args.length > 5 && args[5] instanceof Number ? ((Number) args[5]).intValue() : 128;
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(encrypt ? Cipher.ENCRYPT_MODE : Cipher.DECRYPT_MODE, key, new GCMParameterSpec(tagBits, unb64(args[2])));
            if (args.length > 4 && args[4] != null && args[4].toString().length() > 0) cipher.updateAAD(unb64(args[4]));
        } else if (args[0].toString().contains("ECB")) {
            cipher = Cipher.getInstance("AES/ECB/PKCS5Padding");
            cipher.init(encrypt ? Cipher.ENCRYPT_MODE : Cipher.DECRYPT_MODE, key);
        } else {
            cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
            cipher.init(encrypt ? Cipher.ENCRYPT_MODE : Cipher.DECRYPT_MODE, key, new IvParameterSpec(unb64(args[2])));
        }
        return b64(cipher.doFinal(unb64(args[3])));
    }

    /** args: pw, salt, iterations, hash, bits；API 26+ 才支持 SHA-384/512 */
    private static Object pbkdf2(Object[] args) throws Exception {
        PBEKeySpec spec = new PBEKeySpec(new String(unb64(args[0]), StandardCharsets.ISO_8859_1).toCharArray(),
                unb64(args[1]), ((Number) args[2]).intValue(), ((Number) args[4]).intValue());
        return b64(SecretKeyFactory.getInstance("PBKDF2WithHmac" + jcaHash(args[3])).generateSecret(spec).getEncoded());
    }

    private static Object hmacSign(Object[] args) throws Exception {
        String h = jcaHash(args[2]);
        Mac mac = Mac.getInstance("Hmac" + h);
        mac.init(new SecretKeySpec(unb64(args[0]), "Hmac" + h));
        return b64(mac.doFinal(unb64(args[1])));
    }

    private static Object rsaGen(Object[] args) throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(args[0] instanceof Number ? ((Number) args[0]).intValue() : 1024);
        KeyPair pair = generator.generateKeyPair();
        // base64 字符集不含引号/反斜杠，可直接拼 JSON
        return "{\"publicKey\":\"" + b64(pair.getPublic().getEncoded()) + "\",\"privateKey\":\"" + b64(pair.getPrivate().getEncoded()) + "\"}";
    }

    private static Key keyOf(Object keyB64, Object isPublic) throws Exception {
        KeyFactory factory = KeyFactory.getInstance("RSA");
        return isPublic instanceof Number && ((Number) isPublic).intValue() == 1
                ? factory.generatePublic(new X509EncodedKeySpec(unb64(keyB64)))
                : factory.generatePrivate(new PKCS8EncodedKeySpec(unb64(keyB64)));
    }

    /** args: encrypt(1|0), alg("RSA-OAEP"|"RSA-PKCS1-v1_5"), key, isPublic(1|0), data, hash；MGF1 hash 与 OAEP 主 hash 一致（WebCrypto 规范） */
    private static Object rsaCipher(Object[] args) throws Exception {
        boolean encrypt = ((Number) args[0]).intValue() == 1;
        Key key = keyOf(args[2], args[3]);
        Cipher cipher = Cipher.getInstance("RSA");
        if (args[1].toString().contains("OAEP")) {
            String hash = normHash(args[5]);
            cipher.init(encrypt ? Cipher.ENCRYPT_MODE : Cipher.DECRYPT_MODE, key,
                    new OAEPParameterSpec(hash, "MGF1", new MGF1ParameterSpec(hash), PSource.PSpecified.DEFAULT));
        } else {
            cipher.init(encrypt ? Cipher.ENCRYPT_MODE : Cipher.DECRYPT_MODE, key);
        }
        return b64(cipher.doFinal(unb64(args[4])));
    }

    private static Signature signatureOf(Object alg, Object hash, int saltLen) throws Exception {
        Signature signature;
        if (alg.toString().contains("PSS")) {
            signature = Signature.getInstance(jcaHash(hash) + "withRSAandPSS");
            signature.setParameter(new PSSParameterSpec(jcaHash(hash), "MGF1", new MGF1ParameterSpec(normHash(hash)), saltLen, 1));
        } else {
            signature = Signature.getInstance(jcaHash(hash) + "withRSA");
        }
        return signature;
    }

    private static int intOf(Object[] args, int i, int dft) {
        return args.length > i && args[i] instanceof Number ? ((Number) args[i]).intValue() : dft;
    }

    /** args: pkcs8Key, data, alg, hash, saltLen */
    private static Object rsaSign(Object[] args) throws Exception {
        Signature signature = signatureOf(args[2], args[3], intOf(args, 4, 0));
        signature.initSign((PrivateKey) keyOf(args[0], 0));
        signature.update(unb64(args[1]));
        return b64(signature.sign());
    }

    /** args: spkiKey, signature, data, alg, hash, saltLen */
    private static Object rsaVerify(Object[] args) throws Exception {
        Signature signature = signatureOf(args[3], args[4], intOf(args, 5, 0));
        signature.initVerify((PublicKey) keyOf(args[0], 1));
        signature.update(unb64(args[2]));
        return signature.verify(unb64(args[1])) ? "1" : "0";
    }
}
