package bh.box.plugin.extractor.clearkey;

import com.github.catvod.utils.LOG;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 一个 ClearKey 流式解密任务（单流起播 + 大文件分段并行混合版）：
 * <ol>
 *   <li><b>起播路径（关键）</b>：头部连接从 0 开始<b>单流贯到底、永不中途换连接</b>——
 *       moov 一完整即解析出解密任务并修剪（头部立即可读），随后数据继续沿同一连接流式喂入
 *       {@link PlainWriter}：间隙直写、sample 内存解密后直写明文（密文不落盘），
 *       {@code readyPos}（明文水位）随每块写入<b>实时推进</b>。
 *       短剧单集（约 9MB）全程走此路径，与最快起播的单流版行为完全一致；</li>
 *   <li>仅当剩余未下载量 &gt; {@code parallelMinRemain}（大文件/长视频）时，
 *       顺序预跑 {@code seqHeadBytes} 后才断开头部连接、切换为条带并行
 *       （K 条连接轮流认领条带 i, i+K, i+2K…，消费侧乱序重装、顺序驱动写入器），
 *       提升中段吞吐——起播阶段零额外握手；</li>
 *   <li>{@code readyPos} 实时推进，RangeServer 仅在播放器越过水位时短暂等待。</li>
 * </ol>
 * 状态流转：DOWNLOADING（头部未解析）→ STREAMING（moov 已解析）→ READY / FAILED。
 * 无 Content-Length 的源（极少见）自然退化为单流顺序流水线。
 */
final class ClearKeyEntry {

    private static final String TAG = "ClearKeyProxy";
    private static final int CONNECT_TIMEOUT = 15_000;
    private static final int READ_TIMEOUT = 30_000;
    /** 投喂块大小（每块独立缓冲，进队列供消费线程重装） */
    private static final int CHUNK = 256 * 1024;
    /** 条带大小：一个 Range 请求拉取的区间。太小会放大握手/slow-start 开销，2MB 折中 */
    private static final int STRIPE = 2 * 1024 * 1024;
    /** 并行连接数 */
    private static final int PARALLEL = 4;
    /** moov 之后顺序继续预跑的字节数（超过且剩余量足够才切并行）。调大 = 起播/前段更稳 */
    static volatile long seqHeadBytes = 8L * 1024 * 1024;
    /** 剩余未下载量超过此值切并行才划算（小于它单流跑完，避免握手开销倒赔） */
    static volatile long parallelMinRemain = 12L * 1024 * 1024;
    /** 块队列容量（乱序重装缓冲 + 在途块，内存上界 ≈ (2×K+2+K)×CHUNK ≈ 2.5MB） */
    private static final int QUEUE_CAP = PARALLEL * 2 + 2;
    /** 消费端等待块的最长时间 */
    private static final int CONSUME_TIMEOUT = 150_000;

    static final int STATUS_DOWNLOADING = 0;
    static final int STATUS_STREAMING = 1;
    static final int STATUS_READY = 2;
    static final int STATUS_FAILED = 3;

    final String id;
    private final String sourceUrl;
    private final Map<String, byte[]> keys;
    private final Map<String, String> headers;
    private final File cacheFile;

    private volatile int status = STATUS_DOWNLOADING;
    private volatile String error = "";
    private volatile Thread worker;
    private volatile List<Thread> producers = new ArrayList<>();
    private volatile Exception producerError;
    /** [0, readyPos) 已是明文；READY 时等于文件总长 */
    private volatile long readyPos = 0;
    /** CDN Content-Length；-1 表示未知 */
    private volatile long totalSize = -1;
    private final Object lock = new Object();

    ClearKeyEntry(String id, String sourceUrl, Map<String, byte[]> keys, Map<String, String> headers, File cacheFile) {
        this.id = id;
        this.sourceUrl = sourceUrl;
        this.keys = keys;
        this.headers = headers;
        this.cacheFile = cacheFile;
    }

    int status() {
        return status;
    }

    /** 当前明文可读终点 */
    long readyPos() {
        return readyPos;
    }

    /** 文件总长（CDN Content-Length；未就绪且未知时返回 -1） */
    long totalSize() {
        if (totalSize > 0) return totalSize;
        if (status == STATUS_READY) return cacheFile.length();
        return -1;
    }

    String statusText() {
        switch (status) {
            case STATUS_STREAMING: {
                long total = totalSize;
                long pct = total > 0 ? readyPos * 100 / total : 0;
                return "边下边解 " + pct + "%";
            }
            case STATUS_READY:
                return "就绪";
            case STATUS_FAILED:
                return "失败: " + error;
            default:
                return "下载头部中";
        }
    }

    File file() {
        return cacheFile;
    }

    /** 等待整体就绪；READY 返回 true，FAILED/超时返回 false */
    boolean awaitReady(long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        synchronized (lock) {
            while (status != STATUS_READY && status != STATUS_FAILED) {
                long remain = deadline - System.currentTimeMillis();
                if (remain <= 0) return false;
                try {
                    lock.wait(Math.min(remain, 500));
                } catch (InterruptedException e) {
                    return false;
                }
            }
            return status == STATUS_READY;
        }
    }

    /**
     * 等待位置 {@code pos} 处的数据可读（readyPos &gt; pos）。
     * READY/FAILED/超时返回；FAILED 或超时返回 false。
     */
    boolean awaitRange(long pos, long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        synchronized (lock) {
            while (readyPos <= pos && status != STATUS_FAILED) {
                long remain = deadline - System.currentTimeMillis();
                if (remain <= 0) return false;
                try {
                    lock.wait(Math.min(remain, 200));
                } catch (InterruptedException e) {
                    return false;
                }
            }
            return status != STATUS_FAILED && readyPos > pos;
        }
    }

    /** 已完成（READY 且文件存在）则直接复用 */
    boolean isReady() {
        return status == STATUS_READY && cacheFile.isFile() && cacheFile.length() > 0;
    }

    void launch() {
        Thread t = new Thread(this::run, "ClearKeyProxy-dl-" + id);
        t.setDaemon(true);
        worker = t;
        t.start();
    }

    void cancel() {
        Thread t = worker;
        if (t != null && t.isAlive()) t.interrupt();
        for (Thread p : producers) p.interrupt();
    }

    void deleteFiles() {
        cancel();
        cacheFile.delete();
    }

    // ---------------- 流水线主体 ----------------

    private void run() {
        RandomAccessFile raf = null;
        HttpURLConnection headConn = null;
        long t0 = System.currentTimeMillis();
        try {
            raf = new RandomAccessFile(cacheFile, "rw");

            // 阶段一：顺序下载头部，moov 一完整即解析 + 修剪
            headConn = open(null);
            int code = headConn.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new IOException("下载失败 HTTP " + code);
            }
            totalSize = headConn.getContentLength();
            InputStream headIn = headConn.getInputStream();

            byte[] buffer = new byte[CHUNK];
            long downloaded = 0;
            int lastN = 0;
            CencDecryptor.Parsed parsed = null;
            while (parsed == null) {
                int n = headIn.read(buffer);
                if (n < 0) {
                    throw new IOException("连接在 moov 完整前中断（可能不是 unfragmented CENC MP4）");
                }
                raf.seek(downloaded);
                raf.write(buffer, 0, n);
                downloaded += n;
                lastN = n;
                parsed = CencDecryptor.parse(raf, downloaded, keys);
            }
            // IV/subsample 已全部读入内存，立即修剪 moov：头部区间即刻全部可读
            CencDecryptor.pruneMoov(raf, parsed);
            List<CencDecryptor.Task> tasks = parsed.tasks;
            if (tasks.isEmpty()) {
                throw new IOException("未发现加密轨道（无 sinf/tenc），文件可能不是 CENC MP4");
            }
            // 少见布局（mdat 在 moov 之前）：已落盘的密文 sample 原位解密
            for (CencDecryptor.Task t : tasks) {
                if (t.offset + t.size > parsed.moovEnd) break;
                CencDecryptor.decryptTask(raf, t);
            }
            readyPos = parsed.moovEnd;
            status = STATUS_STREAMING;
            LOG.i(TAG, "moov 解析完成: tasks=" + tasks.size() + ", moovEnd=" + parsed.moovEnd
                    + "B, total=" + totalSize + "B, 头部耗时 " + (System.currentTimeMillis() - t0)
                    + "ms，开始单流边下边解");
            notifyLocked();

            PlainWriter writer = new PlainWriter(raf, tasks, parsed.moovEnd);

            // 头部阶段按块读取，完成 moov 的那一块往往多读了 [moovEnd, downloaded) 的
            // mdat 字节——它们仍在 buffer 里，必须先补喂给写入器，否则流与游标错位
            long fed = parsed.moovEnd;
            int tailStart = (int) (parsed.moovEnd - (downloaded - lastN));
            if (tailStart < lastN) {
                writer.process(buffer, tailStart, lastN - tailStart, fed);
                fed += lastN - tailStart;
                readyPos = writer.pos();
                notifyLocked();
            }

            // 阶段二（起播关键路径）：沿用头部连接单流顺序喂入，水位实时推进。
            // 不换连接 = 无额外握手；短剧单集全程走这里，与最快起播版行为一致。
            long total = totalSize;
            long t1 = System.currentTimeMillis();
            long switchPoint = total > 0 ? Math.min(total, parsed.moovEnd + seqHeadBytes) : Long.MAX_VALUE;
            boolean goParallel = false;
            byte[] buf = new byte[CHUNK];
            int lastLogged = 0;
            while (true) {
                int n = headIn.read(buf);
                if (n < 0) break;
                if (Thread.currentThread().isInterrupted()) {
                    throw new IOException("下载已取消");
                }
                writer.process(buf, 0, n, fed);
                fed += n;
                readyPos = writer.pos();
                notifyLocked();
                if (total > 0) {
                    int pct = (int) (fed * 100 / total);
                    if (pct >= lastLogged + 25) {
                        LOG.i(TAG, "边下边解 " + pct + "%");
                        lastLogged = pct;
                    }
                }
                // 剩余量足够大才值得切并行（起播早已越过这段，只提升中段吞吐）
                if (fed >= switchPoint && total - fed >= parallelMinRemain) {
                    goParallel = true;
                    break;
                }
            }

            if (goParallel) {
                // 大文件/长视频：头部连接使命完成（中途断开必须 disconnect），切条带并行
                headConn.disconnect();
                headConn = null;
                LOG.i(TAG, "顺序预跑至 " + fed + "B，剩余 " + (total - fed)
                        + "B 切换条带并行");
                runParallel(writer, fed, total);
            }

            if (writer.hasPendingSample()) {
                throw new IOException("数据不足，最后一个 sample 未攒齐");
            }
            if (totalSize > 0 && writer.pos() != totalSize) {
                throw new IOException("流水线未覆盖全文件: " + writer.pos() + "/" + totalSize);
            }
            readyPos = writer.pos();
            synchronized (lock) {
                status = STATUS_READY;
                lock.notifyAll();
            }
            LOG.i(TAG, "解密完成: " + cacheFile.getName() + " (" + readyPos / 1024 + "KB), 流水线阶段耗时 "
                    + (System.currentTimeMillis() - t1) + "ms");
        } catch (Exception e) {
            LOG.e(TAG, "解密任务失败: " + e.getMessage());
            for (Thread p : producers) p.interrupt();
            synchronized (lock) {
                status = STATUS_FAILED;
                error = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                lock.notifyAll();
            }
        } finally {
            if (raf != null) {
                try {
                    raf.close();
                } catch (IOException ignored) {
                }
            }
            if (headConn != null) headConn.disconnect();
        }
    }

    /**
     * B1 主路径（仅大文件触发）：条带并行下载 + 乱序重装顺序消费。
     * 连接 i 认领条带 i, i+K, i+2K…（AtomicInteger 分配），水位推进速度 = 聚合带宽。
     */
    private void runParallel(PlainWriter writer, long start, long total) throws Exception {
        long pipeLen = total - start;
        int stripeCount = (int) ((pipeLen + STRIPE - 1) / STRIPE);
        int workers = Math.min(PARALLEL, stripeCount);
        AtomicInteger nextStripe = new AtomicInteger(0);
        ArrayBlockingQueue<Piece> queue = new ArrayBlockingQueue<>(QUEUE_CAP);

        List<Thread> list = new ArrayList<>(workers);
        for (int i = 0; i < workers; i++) {
            Thread t = new Thread(() -> produceStriped(nextStripe, stripeCount, start, total, queue),
                    "ClearKeyProxy-seg" + i);
            t.setDaemon(true);
            list.add(t);
            t.start();
        }
        producers = list;

        try {
            long expect = start;
            HashMap<Long, Piece> reorder = new HashMap<>();
            int lastLogged = 0;
            while (expect < total) {
                if (Thread.currentThread().isInterrupted()) {
                    throw new IOException("下载已取消");
                }
                Piece pc = queue.poll(CONSUME_TIMEOUT, TimeUnit.MILLISECONDS);
                if (pc == null) {
                    throw new IOException("分块等待超时");
                }
                if (pc.len < 0) { // 生产者失败毒丸
                    throw new IOException("分段下载失败: "
                            + (producerError != null ? producerError.getMessage() : "未知"));
                }
                if (pc.offset != expect) {
                    // 乱序块：暂存重装（在途块总数 ≤ workers，缓冲有界）
                    if (pc.offset < expect || reorder.put(pc.offset, pc) != null) {
                        throw new IOException("分块错乱: offset=" + pc.offset + " expect=" + expect);
                    }
                    continue;
                }
                expect = consume(writer, pc, expect);
                Piece pending;
                while ((pending = reorder.remove(expect)) != null) {
                    expect = consume(writer, pending, expect);
                }
                int pct = (int) ((expect - start) * 100 / pipeLen);
                if (pct >= lastLogged + 25) {
                    LOG.i(TAG, "边下边解 " + pct + "%");
                    lastLogged = pct;
                }
            }
        } finally {
            for (Thread p : list) p.interrupt();
        }
    }

    private long consume(PlainWriter writer, Piece pc, long expect) throws IOException {
        writer.process(pc.data, 0, pc.len, pc.offset);
        readyPos = writer.pos(); // 并行阶段同样实时推进水位
        notifyLocked();
        return expect + pc.len;
    }

    /** 条带生产者：AtomicInteger 认领条带，逐条带 Range 下载投喂 */
    private void produceStriped(AtomicInteger nextStripe, int stripeCount, long start, long total,
                                ArrayBlockingQueue<Piece> queue) {
        try {
            while (!Thread.currentThread().isInterrupted()) {
                int idx = nextStripe.getAndIncrement();
                if (idx >= stripeCount) return;
                long s = start + (long) idx * STRIPE;
                long e = Math.min(s + STRIPE, total);
                fetchRange(s, e, queue);
            }
        } catch (Exception e) {
            producerError = e;
            try {
                queue.put(Piece.END);
            } catch (InterruptedException ignored) {
            }
        }
    }

    /** 单个 Range 区间下载：206 强校验 + Content-Range 起点校验，块缓冲独立分配。
     *  成功路径只关流不断开（连接回池供下一条带复用，省握手）；失败才 disconnect。 */
    private void fetchRange(long start, long end, ArrayBlockingQueue<Piece> queue) throws Exception {
        HttpURLConnection conn = open("bytes=" + start + "-" + (end - 1));
        InputStream in = null;
        boolean ok = false;
        try {
            int code = conn.getResponseCode();
            if (code != 206) {
                throw new IOException("Range 请求被拒: HTTP " + code + " [" + start + "-" + (end - 1) + "]");
            }
            String cr = conn.getHeaderField("Content-Range");
            if (cr != null && !cr.startsWith("bytes " + start + "-")) {
                throw new IOException("Content-Range 起点不符: " + cr);
            }
            in = conn.getInputStream();
            long pos = start;
            while (pos < end) {
                byte[] buf = new byte[CHUNK];
                int n = in.read(buf, 0, (int) Math.min(buf.length, end - pos));
                if (n < 0) throw new IOException("分段提前结束 @ " + pos);
                if (n == 0) continue;
                if (Thread.currentThread().isInterrupted()) {
                    throw new IOException("已取消");
                }
                queue.put(new Piece(pos, buf, n));
                pos += n;
            }
            ok = true;
        } finally {
            if (ok) {
                try {
                    if (in != null) in.close(); // 流已到 EOF，close 将连接还给池复用
                } catch (IOException ignored) {
                }
            } else {
                conn.disconnect();
            }
        }
    }

    /** 建立 CDN 连接（统一超时 / 头部；identity 防 gzip 长度错位） */
    private HttpURLConnection open(String range) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(sourceUrl).openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT);
        conn.setReadTimeout(READ_TIMEOUT);
        conn.setRequestMethod("GET");
        conn.setRequestProperty("Accept-Encoding", "identity");
        if (range != null) conn.setRequestProperty("Range", range);
        if (headers != null) {
            for (Map.Entry<String, String> h : headers.entrySet()) {
                if (!isEmpty(h.getKey()) && !isEmpty(h.getValue())) {
                    conn.setRequestProperty(h.getKey(), h.getValue());
                }
            }
        }
        return conn;
    }

    private void notifyLocked() {
        synchronized (lock) {
            lock.notifyAll();
        }
    }

    private static boolean isEmpty(String s) {
        return s == null || s.trim().isEmpty();
    }

    // ---------------- 流水线数据结构 ----------------

    /** 一块按偏移到达的数据；len &lt; 0 表示生产者失败毒丸 */
    private static final class Piece {
        static final Piece END = new Piece(-1, null, -1);

        final long offset;
        final byte[] data;
        final int len;

        Piece(long offset, byte[] data, int len) {
            this.offset = offset;
            this.data = data;
            this.len = len;
        }
    }
}
