package bh.box.plugin.extractor.clearkey;

import com.github.catvod.utils.LOG;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 极简本地 HTTP/1.1 文件服务器：只服务 /ck/&lt;entryId&gt; 一个路径族。
 * <ul>
 *   <li>仅绑定 127.0.0.1，随机端口；</li>
 *   <li>支持 GET/HEAD、单区间 Range（206/416）、Content-Length；</li>
 *   <li>Connection: close（每连接一次响应后关闭，播放器内核均兼容）；</li>
 *   <li>流式供数：响应头立即发出（总长取 CDN Content-Length），数据逐块写出，
 *       未解密到请求位置时挂起等待解密推进（播放器视作慢源）。</li>
 * </ul>
 */
final class RangeServer {

    private static final String TAG = "ClearKeyProxy";
    private static final String CONTENT_TYPE = "video/mp4";
    private static final int MAX_ENTRIES = 16;

    private final ConcurrentHashMap<String, ClearKeyEntry> entries;
    private ServerSocket server;
    private Thread acceptThread;
    private volatile boolean closed;

    RangeServer(ConcurrentHashMap<String, ClearKeyEntry> entries) {
        this.entries = entries;
    }

    /** 启动并返回实际端口；已启动直接返回 */
    synchronized int start() throws IOException {
        if (server != null && !server.isClosed()) {
            return server.getLocalPort();
        }
        closed = false;
        server = new ServerSocket();
        server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0));
        int port = server.getLocalPort();
        acceptThread = new Thread(this::acceptLoop, "ClearKeyProxy-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
        LOG.i(TAG, "本地解密代理已启动: 127.0.0.1:" + port);
        return port;
    }

    synchronized void close() {
        closed = true;
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
        }
        if (acceptThread != null) acceptThread.interrupt();
        server = null;
        acceptThread = null;
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                Socket socket = server.accept();
                Thread worker = new Thread(() -> handle(socket), "ClearKeyProxy-conn");
                worker.setDaemon(true);
                worker.start();
            } catch (SocketException e) {
                if (closed) return; // 正常关闭
                LOG.e(TAG, "accept 异常: " + e.getMessage());
            } catch (IOException e) {
                LOG.e(TAG, "accept IO 异常: " + e.getMessage());
            }
        }
    }

    private void handle(Socket socket) {
        try {
            socket.setSoTimeout(10_000);
            InputStream in = socket.getInputStream();
            OutputStream out = new BufferedOutputStream(socket.getOutputStream(), 64 * 1024);
            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            String path = parts[1];
            String rangeHeader = null;
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon <= 0) continue;
                String name = line.substring(0, colon).trim();
                if ("Range".equalsIgnoreCase(name)) rangeHeader = line.substring(colon + 1).trim();
            }
            if (!path.startsWith("/ck/")) {
                respond(out, "404 Not Found", null, -1, null, false);
                return;
            }
            String id = path.substring("/ck/".length());
            int query = id.indexOf('?');
            if (query >= 0) id = id.substring(0, query);
            ClearKeyEntry entry = entries.get(id);
            if (entry == null) {
                respond(out, "404 Not Found", null, -1, null, false);
                return;
            }
            serve(out, method, rangeHeader, entry);
        } catch (SocketTimeoutException ignored) {
        } catch (Exception e) {
            LOG.e(TAG, "请求处理异常: " + e.getMessage());
        } finally {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    /** 流式按 Range 输出：头部立即发出，数据逐块等待解密推进后写出 */
    private void serve(OutputStream out, String method, String rangeHeader, ClearKeyEntry entry) throws IOException {
        long total = entry.totalSize();
        if (total <= 0) {
            // 总长未知（无 Content-Length 的源，极少见）：回退等全量就绪
            if (!entry.awaitReady(150_000)) {
                LOG.e(TAG, "条目未就绪且总长未知: " + entry.id + " -> " + entry.statusText());
                respond(out, "500 Internal Server Error", null, -1, null, false);
                return;
            }
            total = entry.file().length();
        }
        long start = 0;
        long end = total - 1;
        boolean partial = false;
        if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
            String spec = rangeHeader.substring("bytes=".length()).trim();
            int comma = spec.indexOf(','); // 不支持多区间，取第一段
            if (comma >= 0) spec = spec.substring(0, comma).trim();
            int dash = spec.indexOf('-');
            if (dash >= 0) {
                String s = spec.substring(0, dash).trim();
                String e = spec.substring(dash + 1).trim();
                if (s.isEmpty() && !e.isEmpty()) {
                    // suffix range: bytes=-N → 末尾 N 字节
                    long n = Long.parseLong(e);
                    if (n <= 0) {
                        respond(out, "416 Range Not Satisfiable", null, -1, null, false);
                        return;
                    }
                    start = Math.max(0, total - n);
                } else {
                    start = Long.parseLong(s);
                    if (!e.isEmpty()) end = Math.min(Long.parseLong(e), total - 1);
                }
            }
            if (start < 0 || start >= total || end < start) {
                respond(out, "416 Range Not Satisfiable", null, -1, null, false);
                return;
            }
            partial = true;
        }
        long length = end - start + 1;
        String status = partial ? "206 Partial Content" : "200 OK";
        boolean head = "HEAD".equalsIgnoreCase(method);
        writeHeaders(out, status, length, partial ? String.format(Locale.US, "bytes %d-%d/%d", start, end, total) : null, head);
        if (head) {
            out.flush();
            return;
        }
        try (RandomAccessFile raf = new RandomAccessFile(entry.file(), "r")) {
            raf.seek(start);
            byte[] buffer = new byte[64 * 1024];
            long remaining = length;
            while (remaining > 0) {
                long pos = start + (length - remaining);
                // 数据未解密到当前位置：等待下载/解密推进（播放器视作慢源）
                if (!entry.awaitRange(pos, 150_000)) {
                    LOG.e(TAG, "流式等待失败 @ " + pos + ": " + entry.statusText());
                    return; // 连接由 finally 关闭，播放器按源中断处理
                }
                long readable = entry.readyPos() - pos;
                int n = raf.read(buffer, 0, (int) Math.min(Math.min(buffer.length, remaining), Math.max(1, readable)));
                if (n < 0) return;
                out.write(buffer, 0, n);
                remaining -= n;
            }
        }
        out.flush();
    }

    private void respond(OutputStream out, String status, String contentRange, long length, byte[] body, boolean head) throws IOException {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(status).append("\r\n");
        if (contentRange != null) sb.append("Content-Range: ").append(contentRange).append("\r\n");
        if (length >= 0) sb.append("Content-Length: ").append(length).append("\r\n");
        sb.append("Content-Type: ").append(CONTENT_TYPE).append("\r\n");
        sb.append("Connection: close\r\n\r\n");
        out.write(sb.toString().getBytes("ISO-8859-1"));
        if (!head && body != null && length > 0) out.write(body);
        out.flush();
    }

    private void writeHeaders(OutputStream out, String status, long length, String contentRange, boolean head) throws IOException {
        respond(out, status, contentRange, length, null, head);
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder(64);
        int prev = -1;
        while (true) {
            int c = in.read();
            if (c < 0) return sb.length() == 0 ? null : sb.toString();
            if (prev == '\r' && c == '\n') {
                sb.setLength(sb.length() - 1);
                return sb.toString();
            }
            sb.append((char) c);
            prev = c;
            if (sb.length() > 8192) throw new IOException("请求头过长");
        }
    }
}
