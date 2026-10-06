package bh.box.plugin.extractor.jianpian;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.StatFs;

import com.github.catvod.exception.AppException;
import com.github.catvod.plugin.IExtractorPlugin;
import com.github.catvod.plugin.bean.UrlBean;
import com.github.catvod.utils.Io;
import com.github.catvod.utils.Path;
import com.p2p.P2PClass;

import java.io.File;
import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.Executors;

public class JianPianExtractorPlugin implements IExtractorPlugin, Clock.Callback {

    public static final String ID = "bh.box.plugin.extractor.jianpian";

    private P2PClass p2p;
    private String path;
    private Clock clock;

    @Override
    public boolean canPlay(String url) {
        String scheme = scheme(url);
        return "tvbox-xg".equals(scheme) || "jianpian".equals(scheme) || "ftp".equals(scheme);
    }

    @Override
    public boolean canParse(String url) {
        return false;
    }

    @Override
    public UrlBean parse(UrlBean urls) {
        return null;
    }

    private void initP2P() {
        if (p2p == null) p2p = new P2PClass();
        if (clock == null) clock = new DefaultClock();
    }

    @Override
    public String getUrl(String url) throws AppException {
        initP2P();
        stop(false);
        check(10);
        start(url);
        try {
            return "http://127.0.0.1:" + p2p.port + "/" + URLEncoder.encode(Uri.parse(path).getLastPathSegment(), "GBK");
        } catch (UnsupportedEncodingException e) {
            throw new AppException(e.getMessage());
        }
    }

    private void check(int limit) {
        double cache = getDirectorySize(Path.jpa());
        double total = cache + getAvailableStorageSpace(Path.jpa());
        int percent = (int) (cache / total * 100);
        if (percent > limit) Io.delete(Path.jpa());
    }

    private void start(String url) {
        try {
            path = URLDecoder.decode(url).split("\\|")[0];
            path = path.replace("jianpian://pathtype=url&path=", "");
            path = path.replace("tvbox-xg://", "").replace("tvbox-xg:", "");
            path = path.replace("xg://", "ftp://").replace("xgplay://", "ftp://");
            p2p.P2Pdoxstart(path.getBytes("GBK"));
            clock.setCallback(this);
            clock.start();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    @Override
    public void stop(boolean isExit) {
        try {
            if (clock != null) clock.stop();
            if (p2p == null || path == null) return;
            p2p.P2Pdoxpause(path.getBytes("GBK"));
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            path = null;
        }
        if (isExit) {
            Executors.newSingleThreadExecutor().execute(() -> check(10));
            if (clock != null) clock.release();
        }
    }

    @Override
    public void install() {}

    @Override
    public void init() {}

    @Override
    public void uninstall() { stop(true); }

    @Override
    public void onTimeChanged() {
        long seconds = System.currentTimeMillis() / 1000 % 60;
        if (seconds % 30 == 0) Executors.newSingleThreadExecutor().execute(() -> check(60));
    }

    private static String scheme(String url) {
        if (url == null) return "";
        String scheme = Uri.parse(url).getScheme();
        return scheme == null ? "" : scheme.toLowerCase().trim();
    }

    private static long getDirectorySize(File file) {
        long size = 0;
        if (file == null) return 0;
        File[] files = file.listFiles();
        if (file.isDirectory() && files != null) for (File f : files) size += getDirectorySize(f);
        else size = file.length();
        return size;
    }

    private static long getAvailableStorageSpace(File file) {
        try {
            StatFs stat = new StatFs(file.getAbsolutePath());
            return stat.getAvailableBlocksLong() * stat.getBlockSizeLong();
        } catch (Exception e) {
            return 0;
        }
    }
}

interface Clock {

    void setCallback(Callback callback);

    void start();

    void stop();

    void release();

    interface Callback {

        void onTimeChanged();
    }
}

class DefaultClock implements Clock {

    private Clock.Callback callback;
    private Timer timer;
    private final Handler handler = new Handler(Looper.getMainLooper());

    public static Clock create() {
        return new DefaultClock();
    }

    @Override
    public void setCallback(Clock.Callback callback) {
        this.callback = callback;
    }

    @Override
    public void start() {
        stop();
        timer = new Timer();
        timer.schedule(new TimerTask() {
            @Override
            public void run() {
                handler.post(() -> {
                    try {
                        if (callback != null) callback.onTimeChanged();
                    } catch (Exception ignored) {
                    }
                });
            }
        }, 0, 1000);
    }

    @Override
    public void stop() {
        if (timer != null) timer.cancel();
    }

    @Override
    public void release() {
        if (timer != null) timer.cancel();
        callback = null;
    }
}
