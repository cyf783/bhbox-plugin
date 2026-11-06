package bh.box.plugin.extractor.clearkey;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.List;

/**
 * 明文写入器（B2：sample 在内存解密后直写明文，密文不落盘）。
 * <p>
 * 按<b>文件偏移严格递增</b>的顺序消费下载块（生产者保证有序）：
 * <ul>
 *   <li>间隙字节（mdat 头、free 盒等未加密区域）直接落盘；</li>
 *   <li>sample 字节先攒进内存缓冲（chunk 任意切分均可），攒齐后
 *       {@link CencDecryptor#decryptBuffer} 原位解密，再一次性写明文；</li>
 *   <li>{@link #pos()} 即明文水位（readyPos）：所有已写字节对播放器可读。</li>
 * </ul>
 * 起点之前已完整落位的 sample（mdat 位于 moov 之前的少见布局）由构造器跳过，
 * 由调用方负责原位解密。moov 边界不会切分 sample（sample 不跨顶层盒）。
 */
final class PlainWriter {

    private final RandomAccessFile raf;
    private final List<CencDecryptor.Task> tasks;
    private int taskIdx;
    /** 下一块应到达的文件偏移（投喂游标，随每个 chunk 前进） */
    private long fedPos;
    /** 明文水位：[0, writePos) 已落盘且可读（间隙直写 / sample 攒齐解密后推进） */
    private long writePos;
    private byte[] sampleData;
    private int sampleFill;
    private CencDecryptor.Task curTask;

    /**
     * @param startPos 流水线起点（moov 终点），此前区域（含 moov 修剪）视为已就绪
     */
    PlainWriter(RandomAccessFile raf, List<CencDecryptor.Task> tasks, long startPos) {
        this.raf = raf;
        this.tasks = tasks;
        this.fedPos = startPos;
        this.writePos = startPos;
        while (taskIdx < tasks.size() && tasks.get(taskIdx).offset + tasks.get(taskIdx).size <= startPos) {
            taskIdx++;
        }
    }

    /** 明文水位：[0, pos) 已全部是明文（落后于投喂游标，最多差一个在攒 sample 的大小） */
    long pos() {
        return writePos;
    }

    /** 是否仍有未攒齐的 sample（数据不足时为 true，说明文件被截断） */
    boolean hasPendingSample() {
        return sampleData != null;
    }

    /**
     * 消费一段按偏移有序到达的数据。
     *
     * @param data       数据缓冲
     * @param off        起始下标
     * @param len        长度
     * @param fileOffset data[off] 对应的文件绝对偏移（必须与上次投喂终点连续）
     */
    void process(byte[] data, int off, int len, long fileOffset) throws IOException {
        if (fileOffset != fedPos) {
            throw new IOException("数据乱序: 期望 " + fedPos + " 实得 " + fileOffset);
        }
        fedPos += len;
        int p = 0;
        while (p < len) {
            if (sampleData != null) {
                // 正在攒 sample：任意切分都可续接
                int take = Math.min(curTask.size - sampleFill, len - p);
                System.arraycopy(data, off + p, sampleData, sampleFill, take);
                sampleFill += take;
                p += take;
                if (sampleFill == curTask.size) finishSample();
                continue;
            }
            if (taskIdx < tasks.size() && fileOffset + p == tasks.get(taskIdx).offset) {
                curTask = tasks.get(taskIdx);
                sampleData = new byte[curTask.size];
                sampleFill = 0;
                continue;
            }
            // 间隙明文：写到下一个 sample 起点或本块结尾
            int end = len;
            if (taskIdx < tasks.size()) {
                long nextStart = tasks.get(taskIdx).offset;
                if (fileOffset + p > nextStart) {
                    throw new IOException("错过 sample 起点: " + (fileOffset + p) + " > " + nextStart);
                }
                end = (int) Math.min(len, nextStart - (fileOffset + p));
            }
            raf.seek(writePos);
            raf.write(data, off + p, end - p);
            writePos += end - p;
            p = end;
        }
    }

    private void finishSample() throws IOException {
        CencDecryptor.decryptBuffer(sampleData, curTask);
        raf.seek(curTask.offset);
        raf.write(sampleData);
        writePos = curTask.offset + curTask.size;
        sampleData = null;
        sampleFill = 0;
        curTask = null;
        taskIdx++;
    }
}
