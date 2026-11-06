package bh.box.plugin.extractor.clearkey;

import com.github.catvod.utils.LOG;

import java.io.EOFException;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * unfragmented CENC MP4 解密器（moov/mdat 结构，如红果短剧源）。
 * <p>
 * 语义对齐 Box/media 的 UnfragmentedCencDecryptor（EXO 插件真机验证过的实现）：
 * <ul>
 *   <li>仅支持 'cenc'（AES-CTR）保护方案，加密信息来自 stbl 内 senc 盒与 stsd 内 sinf/tenc；</li>
 *   <li>IV 仅接受 0/8/16 字节，不足 16 字节高位补零（Arrays.copyOf 语义）；</li>
 *   <li>subsample 由 senc flags&amp;0x02 决定，条目为 2B 明文长 + 4B 密文长；</li>
 *   <li>keyId 按十六进制匹配；keyId 全零或仅提供一对密钥时放宽为使用首个密钥。</li>
 * </ul>
 * 支持<b>流式</b>使用：moov 下载完整后即可 {@link #parse} 出全部解密任务（按文件偏移升序），
 * 随后每下载完一个完整 sample 即可 {@link #decryptTask} 单点解密（等长原位写回，AES-CTR 无填充）。
 * 修剪（{@link #pruneMoov}）在解析完成、IV 全部读入内存后立即执行，零尺寸漂移：
 * senc 盒与 sinf/frma 盒改写为 'free'，stsd 加密 entry 的 4CC 恢复为 frma 声明的原始格式。
 */
final class CencDecryptor {

    private static final String TAG = "ClearKeyProxy";
    /** 单文件解密上限（防止异常文件拖爆磁盘） */
    private static final long MAX_FILE_SIZE = 512L * 1024 * 1024;
    private static final int MAX_SAMPLE_SIZE = 32 * 1024 * 1024;

    private CencDecryptor() {
    }

    /** probe 结果 */
    static final int PROBE_UNFRAGMENTED = 1;
    static final int PROBE_FRAGMENTED = 2;
    static final int PROBE_UNKNOWN = 0;

    /**
     * 探测头部数据里的 moov 是否为 unfragmented 结构（有 trak&gt;stbl 且 moov 无 mvex）。
     *
     * @param head 文件头部若干字节（须完整覆盖 moov 才能可靠判定）
     */
    static int probe(byte[] head) {
        try {
            Node root = Node.memoryRoot(head, 0, head.length);
            for (Node box : root.children) {
                if (!"moov".equals(box.type)) continue;
                if (find(box, "mvex") != null) return PROBE_FRAGMENTED;
                boolean hasStbl = false;
                for (Node trak : box.children) {
                    if ("trak".equals(trak.type) && find(trak, "stbl") != null) hasStbl = true;
                }
                return hasStbl ? PROBE_UNFRAGMENTED : PROBE_FRAGMENTED;
            }
            return PROBE_UNKNOWN;
        } catch (Exception e) {
            LOG.e(TAG, "probe 失败: " + e.getMessage());
            return PROBE_UNKNOWN;
        }
    }

    // ---------------- 解析（流式：moov 完整即可调用） ----------------

    /** 单个 sample 的解密任务（解密 [offset, offset+size)，等长原位写回） */
    static final class Task {
        final long offset;
        final int size;
        final byte[] iv;        // 原始 IV（长度 = per-sample IV size 或 constant IV 长度），解密时统一补零到 16 字节
        final byte[] key;
        final int[] subClear;   // null = 整段加密（无 subsample）
        final int[] subEncrypted;

        Task(long offset, int size, byte[] iv, byte[] key, int[] subClear, int[] subEncrypted) {
            this.offset = offset;
            this.size = size;
            this.iv = iv;
            this.key = key;
            this.subClear = subClear;
            this.subEncrypted = subEncrypted;
        }
    }

    /** 一个加密轨的修剪点（moov 内，文件绝对偏移） */
    private static final class DrmBox {
        final long entryFileOffset; // stsd 加密 entry 盒头起始
        final byte[] originalType;  // frma 声明的原始 4CC（avc1/hvc1/mp4a...）
        final long frmaFileOffset;
        final long sinfFileOffset;
        final Node senc;            // RAF 模式节点，可为 null

        DrmBox(long entryFileOffset, byte[] originalType, long frmaFileOffset, long sinfFileOffset, Node senc) {
            this.entryFileOffset = entryFileOffset;
            this.originalType = originalType;
            this.frmaFileOffset = frmaFileOffset;
            this.sinfFileOffset = sinfFileOffset;
            this.senc = senc;
        }
    }

    /** 解析结果：按文件偏移升序的解密任务 + 修剪点 + moov 终点 */
    static final class Parsed {
        final List<Task> tasks;
        final List<DrmBox> drmBoxes;
        final long moovEnd;

        Parsed(List<Task> tasks, List<DrmBox> drmBoxes, long moovEnd) {
            this.tasks = tasks;
            this.drmBoxes = drmBoxes;
            this.moovEnd = moovEnd;
        }
    }

    /**
     * 解析已下载的前 {@code span} 字节。moov 尚未完整时返回 {@code null}（调用者稍后重试）；
     * moov 完整但内容非法时抛异常。所有加密轨的 IV/subsample 在此一次性读入内存，
     * 之后即可对 moov 区域做修剪。
     */
    static Parsed parse(RandomAccessFile raf, long span, Map<String, byte[]> keys) throws Exception {
        long moovEnd = findCompleteMoovEnd(raf, span);
        if (moovEnd < 0) return null;
        Node root = Node.fileRoot(raf, 0, moovEnd);
        Node moov = null;
        for (Node top : root.children) {
            if ("moov".equals(top.type)) {
                moov = top;
                break;
            }
        }
        if (moov == null) return null; // 理论不可达（findCompleteMoovEnd 已确认）
        List<Task> tasks = new ArrayList<>();
        List<DrmBox> drmBoxes = new ArrayList<>();
        for (Node trak : moov.children) {
            if ("trak".equals(trak.type)) parseTrack(trak, keys, tasks, drmBoxes);
        }
        Collections.sort(tasks, (a, b) -> Long.compare(a.offset, b.offset));
        return new Parsed(tasks, drmBoxes, moovEnd);
    }

    /** 浅扫顶层盒头，返回完整 moov 的终止偏移；moov 未完整/不存在返回 -1 */
    private static long findCompleteMoovEnd(RandomAccessFile raf, long span) throws IOException {
        long p = 0;
        while (p + 8 <= span) {
            raf.seek(p);
            byte[] head = new byte[8];
            raf.readFully(head);
            long size = readUnsignedInt(head, 0);
            long header = 8;
            if (size == 1) {
                if (p + 16 > span) return -1;
                byte[] large = new byte[8];
                raf.readFully(large);
                size = readLong(large, 0);
                header = 16;
            } else if (size == 0) {
                return -1; // 到文件末尾的开放式盒，未定型
            }
            if (size < header) return -1;
            if ("moov".equals(typeOf(head, 4))) {
                return p + size <= span ? p + size : -1;
            }
            if (p + size > span) return -1; // moov 在某个未完整盒之后（probe 已排除，防御）
            p += size;
        }
        return -1;
    }

    /** 解析单个加密轨：生成解密任务并记录修剪点；明文轨直接跳过 */
    private static void parseTrack(Node trak, Map<String, byte[]> keys, List<Task> tasks, List<DrmBox> drmBoxes) throws Exception {
        Node stbl = find(trak, "stbl");
        if (stbl == null) return;
        Node stsd = find(stbl, "stsd");
        if (stsd == null) return;
        DrmEntry drm = findEncryptedEntry(stsd);
        if (drm == null) return;

        if (!"cenc".equals(readSchemeType(drm))) {
            throw new IOException("不支持的保护方案: " + readSchemeType(drm) + "（仅支持 cenc/AES-CTR）");
        }
        TrackEncryption tenc = parseTenc(drm.tenc);
        byte[] key = matchKey(tenc.defaultKeyId, keys);
        if (key == null) {
            throw new IOException("无匹配 ClearKey, kid=" + KodipropParser.toHex(tenc.defaultKeyId));
        }

        // senc：per-sample IV 与 subsample 结构
        byte[][] sampleIvs = null;
        int[][] subsampleClear = null;
        int[][] subsampleEncrypted = null;
        int sencSampleCount = -1;
        Node senc = find(stbl, "senc");
        if (senc != null) {
            byte[] data = senc.readBody();
            int p = 0;
            if (data.length < 8) throw new EOFException("senc 数据过短");
            int fullAtom = readInt(data, p);
            p += 4;
            int version = (fullAtom >>> 24) & 0xFF;
            if (version > 1) {
                throw new IOException("不支持的 senc version: " + version);
            }
            int flags = fullAtom & 0x00FFFFFD;
            if (flags != 0) {
                throw new IOException("不支持的 senc flags: 0x" + Integer.toHexString(fullAtom & 0x00FFFFFF));
            }
            boolean subsampleEncryption = (fullAtom & 0x02) != 0;
            sencSampleCount = readInt(data, p);
            p += 4;
            if (sencSampleCount < 0) throw new IOException("senc sample 数异常: " + sencSampleCount);
            if (version == 1 && tenc.perSampleIvSize == 0) {
                // version 1 且无 per-sample IV 时每个 sample 前还带 16B KID，需额外跳过——
                // 未实现该布局，显式拒绝而不是静默解析错位
                throw new IOException("不支持 senc version 1 + 无 per-sample IV 的布局");
            }
            if (tenc.perSampleIvSize > 0) sampleIvs = new byte[sencSampleCount][];
            if (subsampleEncryption) {
                subsampleClear = new int[sencSampleCount][];
                subsampleEncrypted = new int[sencSampleCount][];
            }
            for (int i = 0; i < sencSampleCount; i++) {
                if (tenc.perSampleIvSize > 0) {
                    if (data.length - p < tenc.perSampleIvSize) throw new EOFException("senc IV 截断");
                    sampleIvs[i] = Arrays.copyOfRange(data, p, p + tenc.perSampleIvSize);
                    p += tenc.perSampleIvSize;
                }
                if (subsampleEncryption) {
                    if (data.length - p < 2) throw new EOFException("senc subsample 数截断");
                    int subCount = readUnsignedShort(data, p);
                    p += 2;
                    if (data.length - p < subCount * 6) throw new EOFException("senc subsample 数据截断");
                    int[] clearSizes = new int[subCount];
                    int[] encSizes = new int[subCount];
                    for (int j = 0; j < subCount; j++) {
                        clearSizes[j] = readUnsignedShort(data, p);
                        p += 2;
                        encSizes[j] = readInt(data, p);
                        p += 4;
                    }
                    subsampleClear[i] = clearSizes;
                    subsampleEncrypted[i] = encSizes;
                }
            }
        } else {
            // 无 senc：要求 tenc 提供 constant IV 且无 per-sample IV
            if (tenc.perSampleIvSize != 0 || tenc.constantIv == null) {
                throw new IOException("缺少 senc 且 tenc 无 constant IV，无法定位加密参数");
            }
        }

        SampleTable table = parseSampleTable(stbl, sencSampleCount);
        for (int i = 0; i < table.count; i++) {
            byte[] iv = sampleIvs != null ? sampleIvs[i] : tenc.constantIv;
            if (iv == null) throw new IOException("sample #" + i + " 缺少 IV");
            if (table.sizes[i] <= 0 || table.sizes[i] > MAX_SAMPLE_SIZE) {
                throw new IOException("sample 大小异常: " + table.sizes[i]);
            }
            tasks.add(new Task(table.offsets[i], table.sizes[i], iv, key,
                    subsampleClear != null ? subsampleClear[i] : null,
                    subsampleEncrypted != null ? subsampleEncrypted[i] : null));
        }
        drmBoxes.add(new DrmBox(drm.entryFileOffset, drm.frma.readBody(),
                drm.frmaFileOffset, drm.sinfFileOffset, senc));
    }

    // ---------------- 修剪（零尺寸漂移，等大小改写） ----------------

    /** 所有轨的 stsd entry 4CC 恢复为 frma 原始格式；frma/sinf/senc 盒 type 改写为 'free' */
    static void pruneMoov(RandomAccessFile raf, Parsed parsed) throws IOException {
        for (DrmBox box : parsed.drmBoxes) {
            if (box.originalType != null && box.originalType.length >= 4) {
                raf.seek(box.entryFileOffset + 4);
                raf.write(box.originalType, 0, 4);
            }
            raf.seek(box.frmaFileOffset + 4);
            raf.write("free".getBytes(StandardCharsets.US_ASCII));
            raf.seek(box.sinfFileOffset + 4);
            raf.write("free".getBytes(StandardCharsets.US_ASCII));
            if (box.senc != null) {
                raf.seek(box.senc.offset + 4);
                raf.write("free".getBytes(StandardCharsets.US_ASCII));
            }
        }
    }

    // ---------------- 解密（单 sample，流式推进用） ----------------

    /** 解密单个 sample：读文件 → 内存原位解密 → 写回（等长，AES-CTR 无填充） */
    static void decryptTask(RandomAccessFile raf, Task task) throws IOException {
        if (task.size <= 0 || task.size > MAX_SAMPLE_SIZE) {
            throw new IOException("sample 大小异常: " + task.size);
        }
        byte[] buffer = new byte[task.size];
        raf.seek(task.offset);
        raf.readFully(buffer, 0, task.size);
        decryptBuffer(buffer, task);
        raf.seek(task.offset);
        raf.write(buffer, 0, task.size);
    }

    /**
     * 在内存中原位解密一个 sample（{@code data.length} 必须等于 {@code task.size}）。
     * B2 流水线用：密文不落盘，内存解密后由调用方直接写明文。
     */
    static void decryptBuffer(byte[] data, Task task) throws IOException {
        if (data.length != task.size) {
            throw new IOException("sample 缓冲长度不符: " + data.length + " != " + task.size);
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/CTR/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(task.key, "AES"),
                    new IvParameterSpec(Arrays.copyOf(task.iv, 16)));
            if (task.subClear == null || task.subEncrypted == null) {
                cipher.doFinal(data, 0, task.size, data, 0);
            } else {
                int pos = 0;
                for (int i = 0; i < task.subClear.length; i++) {
                    int encStart = pos + task.subClear[i];
                    int encEnd = encStart + task.subEncrypted[i];
                    if (encEnd > task.size) throw new IOException("subsample 超出 sample 大小");
                    if (task.subEncrypted[i] > 0) {
                        byte[] chunk = cipher.update(data, encStart, task.subEncrypted[i]);
                        if (chunk == null || chunk.length != task.subEncrypted[i]) {
                            throw new IOException("subsample 解密不完整");
                        }
                        System.arraycopy(chunk, 0, data, encStart, task.subEncrypted[i]);
                    }
                    pos = encEnd;
                }
                if (pos != task.size) throw new IOException("subsample 长度与 sample 不匹配");
                cipher.doFinal();
            }
        } catch (GeneralSecurityException e) {
            throw new IOException("sample 解密失败: " + e.getMessage(), e);
        }
    }

    // ---------------- 全量入口（桌面测试/兼容） ----------------

    /**
     * 对整个文件原位解密。任何轨道缺少匹配密钥时抛异常（保证不产出半解密文件）。
     *
     * @param keys kid(hex 小写) → 16 字节密钥
     */
    static void decrypt(File file, Map<String, byte[]> keys) throws Exception {
        if (file.length() > MAX_FILE_SIZE) {
            throw new IOException("文件超过解密上限 " + MAX_FILE_SIZE / 1024 / 1024 + "MB");
        }
        try (RandomAccessFile raf = new RandomAccessFile(file, "rw")) {
            Parsed parsed = parse(raf, raf.length(), keys);
            if (parsed == null) {
                throw new IOException("未找到 moov（文件可能不是 CENC MP4）");
            }
            if (parsed.tasks.isEmpty()) {
                throw new IOException("未发现加密轨道（无 sinf/tenc），文件可能不是 CENC MP4");
            }
            pruneMoov(raf, parsed);
            for (Task task : parsed.tasks) {
                decryptTask(raf, task);
            }
            LOG.i(TAG, String.format(Locale.US, "全量解密完成: tasks=%d", parsed.tasks.size()));
        }
    }

    // ---------------- tenc / schm 解析 ----------------

    private static final class TrackEncryption {
        byte[] defaultKeyId;
        int perSampleIvSize;
        byte[] constantIv;
    }

    private static TrackEncryption parseTenc(Node tenc) throws IOException {
        byte[] body = tenc.readBody();
        if (body.length < 24) throw new IOException("tenc 过短: " + body.length);
        TrackEncryption t = new TrackEncryption();
        int isProtected = body[6] & 0xFF;
        t.perSampleIvSize = body[7] & 0xFF;
        if (t.perSampleIvSize != 0 && t.perSampleIvSize != 8 && t.perSampleIvSize != 16) {
            throw new IOException("不支持的 CENC IV size: " + t.perSampleIvSize);
        }
        t.defaultKeyId = Arrays.copyOfRange(body, 8, 24);
        if (isProtected == 1 && t.perSampleIvSize == 0) {
            if (body.length < 25) throw new IOException("tenc 缺少 constant IV 长度");
            int ivSize = body[24] & 0xFF;
            if (body.length < 25 + ivSize) throw new IOException("tenc constant IV 截断");
            t.constantIv = Arrays.copyOfRange(body, 25, 25 + ivSize);
        }
        return t;
    }

    /** 在 sinf 范围内搜 schm 读 scheme_type（'cenc'/'cbcs'/...）；找不到时按 'cenc' 兜底 */
    private static String readSchemeType(DrmEntry drm) {
        try {
            byte[] body = drm.sinf.mem; // sinf/tenc/frma 与 entry 共享同一 stsd body 数组
            if (body == null) return "cenc";
            int pos = indexOfMarker(body, drm.sinfStart + 4, drm.sinfEnd, "schm");
            if (pos < 0) return "cenc";
            long size = readUnsignedInt(body, pos - 4);
            if (size < 16 || pos - 4 + size > drm.sinfEnd) return "cenc";
            // box: [size 'schm' version/flags scheme_type]，scheme_type 在标记位置 +8
            return new String(body, pos + 8, 4, StandardCharsets.US_ASCII);
        } catch (Exception e) {
            return "cenc";
        }
    }

    /** kid 匹配：hex 精确；全零 kid 或仅一对密钥时放宽为首个 */
    private static byte[] matchKey(byte[] keyId, Map<String, byte[]> keys) {
        byte[] key = keys.get(KodipropParser.toHex(keyId));
        if (key == null && (isAllZero(keyId) || keys.size() == 1)) {
            key = keys.values().iterator().next();
        }
        return key;
    }

    private static boolean isAllZero(byte[] bytes) {
        for (byte b : bytes) if (b != 0) return false;
        return true;
    }

    // ---------------- sample 表（stsz + stco/co64 + stsc） ----------------

    private static final class SampleTable {
        int count;
        long[] offsets;
        int[] sizes;
    }

    private static SampleTable parseSampleTable(Node stbl, int expectedCount) throws IOException {
        Node stsz = find(stbl, "stsz");
        Node stco = find(stbl, "stco");
        Node co64 = stco == null ? find(stbl, "co64") : null;
        Node stsc = find(stbl, "stsc");
        if (stsz == null || (stco == null && co64 == null) || stsc == null) {
            throw new IOException("缺少 stsz/stco/stsc，无法定位 sample");
        }
        byte[] sz = stsz.readBody();
        if (sz.length < 12) throw new EOFException("stsz 截断");
        int defaultSize = readInt(sz, 4);
        int count = readInt(sz, 8);
        if (count < 0 || count > 1_000_000) throw new IOException("stsz sample 数异常: " + count);
        if (expectedCount >= 0 && expectedCount != count) {
            throw new IOException("senc sample 数 " + expectedCount + " 与 stsz " + count + " 不一致");
        }
        SampleTable table = new SampleTable();
        table.count = count;
        table.sizes = new int[count];
        if (defaultSize != 0) {
            Arrays.fill(table.sizes, defaultSize);
        } else {
            if (sz.length < 12 + (long) count * 4) throw new EOFException("stsz sizes 截断");
            for (int i = 0; i < count; i++) table.sizes[i] = readInt(sz, 12 + i * 4);
        }

        byte[] co = (stco != null ? stco : co64).readBody();
        boolean wide = stco == null;
        if (co.length < 8) throw new EOFException("stco 截断");
        int chunkCount = readInt(co, 4);
        if (chunkCount < 0 || chunkCount > 1_000_000) throw new IOException("stco chunk 数异常: " + chunkCount);
        if (co.length < 8 + (long) chunkCount * (wide ? 8 : 4)) throw new EOFException("stco offsets 截断");
        long[] chunkOffsets = new long[chunkCount];
        for (int i = 0; i < chunkCount; i++) {
            int p = 8 + i * (wide ? 8 : 4);
            chunkOffsets[i] = wide ? readLong(co, p) : readInt(co, p) & 0xFFFFFFFFL;
        }

        byte[] sc = stsc.readBody();
        if (sc.length < 8) throw new EOFException("stsc 截断");
        int scCount = readInt(sc, 4);
        if (scCount <= 0 || sc.length < 8 + (long) scCount * 12) throw new EOFException("stsc 截断");
        table.offsets = new long[count];
        int global = 0;
        for (int e = 0; e < scCount && global < count; e++) {
            int base = 8 + e * 12;
            int firstChunk = readInt(sc, base) - 1;      // 1-based → 0-based
            int samplesPerChunk = readInt(sc, base + 4);
            int lastChunk = e + 1 < scCount ? readInt(sc, base + 12) - 1 : chunkCount;
            if (firstChunk < 0 || firstChunk >= chunkCount) continue;
            for (int c = firstChunk; c < lastChunk && c < chunkCount && global < count; c++) {
                long offset = chunkOffsets[c];
                for (int s = 0; s < samplesPerChunk && global < count; s++) {
                    table.offsets[global] = offset;
                    offset += table.sizes[global] & 0xFFFFFFFFL;
                    global++;
                }
            }
        }
        if (global != count) throw new IOException("sample 表不完整: " + global + "/" + count);
        return table;
    }

    // ---------------- 盒子树 ----------------

    /**
     * MP4 盒节点。内存模式（probe / stsd entry 解析）与 RAF 模式（整文件遍历）统一抽象。
     * 只读；修剪通过外部按 offset 直接写 RAF 完成。
     */
    private static final class Node {
        final RandomAccessFile raf; // null = 内存模式
        final byte[] mem;           // 内存模式数据
        final long offset;          // 盒起始（含 size 头）
        final long size;            // 盒总大小
        final long dataOffset;      // 盒体起始
        final String type;
        Node[] children = new Node[0];

        private Node(RandomAccessFile raf, byte[] mem, long offset, long size, long dataOffset, String type) {
            this.raf = raf;
            this.mem = mem;
            this.offset = offset;
            this.size = size;
            this.dataOffset = dataOffset;
            this.type = type;
        }

        /** 内存模式根：解析 offset..offset+span 内的兄弟盒序列 */
        static Node memoryRoot(byte[] mem, long offset, long span) throws IOException {
            Node root = new Node(null, mem, offset, span, offset, "");
            parseSiblings(mem, offset, span, root);
            return root;
        }

        /** 内存模式单盒 */
        static Node memoryBox(byte[] mem, long offset, long size) throws IOException {
            long header = readUnsignedInt(mem, (int) offset) == 1 ? 16 : 8;
            Node box = new Node(null, mem, offset, size, offset + header, typeOf(mem, (int) offset + 4));
            parseSiblings(mem, box.dataOffset, offset + size, box);
            return box;
        }

        /** RAF 模式根：遍历 offset..offset+span 的兄弟盒序列 */
        static Node fileRoot(RandomAccessFile raf, long offset, long span) throws IOException {
            Node root = new Node(raf, null, offset, span, offset, "");
            List<Node> list = new ArrayList<>();
            long p = offset;
            while (p + 8 <= offset + span) {
                Node child = readFileBox(raf, p, offset + span);
                if (child == null) break;
                list.add(child);
                p += child.size;
            }
            root.children = list.toArray(new Node[0]);
            return root;
        }

        private static void parseSiblings(byte[] mem, long start, long end, Node parent) throws IOException {
            List<Node> list = new ArrayList<>();
            long p = start;
            while (p + 8 <= end) {
                long size = readUnsignedInt(mem, (int) p);
                long header = 8;
                if (size == 1) {
                    if (p + 16 > end) break;
                    size = readLong(mem, (int) p + 8);
                    header = 16;
                } else if (size == 0) {
                    size = end - p; // 到容器末尾
                }
                if (size < header || p + size > end) break;
                Node child = memoryBox(mem, p, size);
                list.add(child);
                p += size;
            }
            parent.children = list.toArray(new Node[0]);
        }

        private static Node readFileBox(RandomAccessFile raf, long offset, long end) throws IOException {
            raf.seek(offset);
            byte[] head = new byte[8];
            raf.readFully(head);
            long size = readUnsignedInt(head, 0);
            long header = 8;
            if (size == 1) {
                byte[] large = new byte[8];
                raf.readFully(large);
                size = readLong(large, 0);
                header = 16;
            } else if (size == 0) {
                size = end - offset;
            }
            if (size < header || offset + size > end) return null;
            Node box = new Node(raf, null, offset, size, offset + header, typeOf(head, 4));
            if (isContainer(box.type)) {
                List<Node> list = new ArrayList<>();
                long p = box.dataOffset;
                while (p + 8 <= box.offset + box.size) {
                    Node child = readFileBox(raf, p, box.offset + box.size);
                    if (child == null) break;
                    list.add(child);
                    p += child.size;
                }
                box.children = list.toArray(new Node[0]);
            }
            return box;
        }

        byte[] readBody() throws IOException {
            int len = (int) (size - (dataOffset - offset));
            byte[] out = new byte[len];
            if (raf != null) {
                raf.seek(dataOffset);
                raf.readFully(out);
            } else {
                System.arraycopy(mem, (int) dataOffset, out, 0, len);
            }
            return out;
        }
    }

    private static boolean isContainer(String type) {
        switch (type) {
            case "moov":
            case "trak":
            case "mdia":
            case "minf":
            case "stbl":
            case "edts":
            case "udta":
                return true;
            default:
                return false;
        }
    }

    private static String typeOf(byte[] data, int offset) {
        if (offset + 4 > data.length) return "";
        return new String(data, offset, 4, StandardCharsets.US_ASCII);
    }

    /** stsd 内一个加密 sample entry 及其 DRM 子盒（标记搜索定位） */
    private static final class DrmEntry {
        Node entry;   // mem 模式，offset 为 stsd body 内偏移
        Node frma;
        Node sinf;
        Node tenc;
        // 供 prune 原位写回的文件绝对偏移（盒头起始）
        long entryFileOffset;
        long frmaFileOffset;
        long sinfFileOffset;
        int sinfStart; // sinf 在 entry body 数组中的 type 起始位置
        int sinfEnd;
    }

    /** stsd 的第一个带 sinf 的加密 sample entry（entry 内布局不固定，用标记搜索定位 DRM 盒） */
    private static DrmEntry findEncryptedEntry(Node stsd) throws IOException {
        byte[] body = stsd.readBody();
        if (body.length < 8) return null;
        int entryCount = readInt(body, 4);
        int p = 8;
        for (int i = 0; i < entryCount && p + 8 <= body.length; i++) {
            long size = readUnsignedInt(body, p);
            if (size < 8 || p + size > body.length) break;
            DrmEntry hit = locateDrmBoxes(body, p, (int) size, stsd.dataOffset);
            if (hit != null) return hit;
            p += size;
        }
        return null;
    }

    /**
     * 在 sample entry 内以四字节标记定位 DRM 盒（不依赖 VisualSampleEntry/AudioSampleEntry
     * 固定头部布局）。标准布局为 sinf{frma, schm, schi{tenc}}：frma 是 sinf 的<b>子盒</b>，
     * 因此先定位 frma/tenc，再向 frma 之前回溯能同时覆盖二者的 sinf 盒头。
     * 强校验：frma size 恒为 12、tenc size ≥ 32、sinf 范围合法，避免二进制误匹配。
     *
     * @param fileBase stsd 盒体的文件绝对偏移（Node.offset 用文件绝对偏移，供 prune 原位写回）
     */
    private static DrmEntry locateDrmBoxes(byte[] body, int off, int len, long fileBase) {
        int end = off + len;
        int frmaType = indexOfMarker(body, off, end, "frma");
        if (frmaType < 0 || frmaType + 8 > end) return null;
        if (readUnsignedInt(body, frmaType - 4) != 12) return null; // frma 盒恒 12 字节
        int tencType = indexOfMarker(body, off, end, "tenc");
        if (tencType < 0) return null;
        long tencSize = readUnsignedInt(body, tencType - 4);
        if (tencSize < 32 || tencType - 4 + tencSize > end) return null;
        // sinf 盒头必在 frma 之前；取满足"覆盖 frma 与 tenc"约束的最后一个候选（最贴近内层）
        int sinfType = -1;
        long sinfSize = 0;
        int from = off + 8;
        while (true) {
            int hit = indexOfMarker(body, from, frmaType, "sinf");
            if (hit < 0) break;
            long sz = readUnsignedInt(body, hit - 4);
            if (sz >= 16 && hit - 4 + sz <= end && hit - 4 + sz >= tencType + 4) {
                sinfType = hit;
                sinfSize = sz;
            }
            from = hit + 4;
        }
        if (sinfType < 0) return null;
        int sinfEnd = sinfType - 4 + (int) sinfSize;

        DrmEntry e = new DrmEntry();
        // Node 为 mem 模式（offset/dataOffset 均为 body 内偏移，readBody 用）；文件绝对偏移单独记录（prune 用）
        e.entry = new Node(null, body, off, len, off + 8, typeOf(body, off + 4));
        e.frma = new Node(null, body, frmaType - 4, 12, frmaType + 4, "frma");
        e.sinf = new Node(null, body, sinfType - 4, sinfSize, sinfType + 4, "sinf");
        e.tenc = new Node(null, body, tencType - 4, tencSize, tencType + 4, "tenc");
        e.entryFileOffset = fileBase + off;
        e.frmaFileOffset = fileBase + frmaType - 4;
        e.sinfFileOffset = fileBase + sinfType - 4;
        e.sinfStart = sinfType;
        e.sinfEnd = sinfEnd;
        return e;
    }

    private static int indexOfMarker(byte[] data, int from, int to, String fourCC) {
        byte[] pattern = fourCC.getBytes(StandardCharsets.US_ASCII);
        outer:
        for (int i = Math.max(from, 0); i <= to - pattern.length; i++) {
            for (int j = 0; j < pattern.length; j++) {
                if (data[i + j] != pattern[j]) continue outer;
            }
            return i;
        }
        return -1;
    }

    /** 深度查找指定 type 的子盒（先直接子盒，后容器递归） */
    private static Node find(Node box, String type) {
        for (Node child : box.children) {
            if (type.equals(child.type)) return child;
        }
        for (Node child : box.children) {
            if (child.children.length > 0) {
                Node hit = find(child, type);
                if (hit != null) return hit;
            }
        }
        return null;
    }

    // ---------------- 基础字节读取 ----------------

    private static long readUnsignedInt(byte[] data, int p) {
        return readInt(data, p) & 0xFFFFFFFFL;
    }

    private static int readInt(byte[] data, int p) {
        return ((data[p] & 0xFF) << 24) | ((data[p + 1] & 0xFF) << 16) | ((data[p + 2] & 0xFF) << 8) | (data[p + 3] & 0xFF);
    }

    private static long readLong(byte[] data, int p) {
        return ((long) readInt(data, p) << 32) | (readInt(data, p + 4) & 0xFFFFFFFFL);
    }

    private static int readUnsignedShort(byte[] data, int p) {
        return ((data[p] & 0xFF) << 8) | (data[p + 1] & 0xFF);
    }
}
