package is.xyz.mpv;

import android.content.Context;
import android.view.Surface;

import androidx.annotation.Nullable;

import java.util.concurrent.CopyOnWriteArrayList;

/**
 * MPV 原生 JNI 桥接层。
 * 声明所有 native 方法，并提供事件/日志观察者分发。
 * 包名必须保持 is.xyz.mpv，与 libplayer.so 中的 JNI 符号名对应。
 */
public final class MPVLib {

    private static final CopyOnWriteArrayList<EventObserver> OBSERVERS = new CopyOnWriteArrayList<>();
    private static final CopyOnWriteArrayList<LogObserver> LOG_OBSERVERS = new CopyOnWriteArrayList<>();

    // ── 生命周期 ──
    public static native void create(Context appctx);
    public static native void init();
    public static native int destroy();

    // ── Surface 管理 ──
    public static native void attachSurface(Surface surface);
    public static native void replaceSurface(Surface surface);
    public static native void detachSurface();

    // ── OSD Surface ──
    public static native void attachOsdSurface(Surface surface);
    public static native void replaceOsdSurface(Surface surface);
    public static native void detachOsdSurface();

    // ── 命令与属性 ──
    /** 入队命令，完成后通过 {@link EventObserver#eventCommandReply} 回调 */
    public static native int enqueueCommand(long requestId, String... cmd);
    public static native int setOptionString(String name, String value);

    public static native Integer getPropertyInt(String property);
    public static native Double getPropertyDouble(String property);
    public static native Boolean getPropertyBoolean(String property);
    public static native String getPropertyString(String property);
    public static native @Nullable byte[] getPropertyByteArray(String property);
    public static native int observeProperty(String property, int format);

    // ── 观察者 ──
    public static void addObserver(EventObserver observer) {
        OBSERVERS.addIfAbsent(observer);
    }

    public static void removeObserver(EventObserver observer) {
        OBSERVERS.remove(observer);
    }

    public static void addLogObserver(LogObserver observer) {
        LOG_OBSERVERS.addIfAbsent(observer);
    }

    public static void removeLogObserver(LogObserver observer) {
        LOG_OBSERVERS.remove(observer);
    }

    // ── 事件分发（由 native 层回调） ──
    public static void eventProperty(String property, long value) {
        for (EventObserver o : OBSERVERS) o.eventProperty(property, value);
    }

    public static void eventProperty(String property, boolean value) {
        for (EventObserver o : OBSERVERS) o.eventProperty(property, value);
    }

    public static void eventProperty(String property, double value) {
        for (EventObserver o : OBSERVERS) o.eventProperty(property, value);
    }

    public static void eventProperty(String property, String value) {
        for (EventObserver o : OBSERVERS) o.eventProperty(property, value);
    }

    public static void eventProperty(String property) {
        for (EventObserver o : OBSERVERS) o.eventProperty(property);
    }

    public static void event(int eventId) {
        for (EventObserver o : OBSERVERS) o.event(eventId);
    }

    public static void eventCommandReply(long requestId, int error) {
        for (EventObserver o : OBSERVERS) o.eventCommandReply(requestId, error);
    }

    public static void eventEndFile(int reason, int error, @Nullable String errorString) {
        for (EventObserver o : OBSERVERS) o.eventEndFile(reason, error, errorString);
    }

    public static void logMessage(String prefix, int level, String text) {
        for (LogObserver o : LOG_OBSERVERS) o.logMessage(prefix, level, text);
    }

    // ── 常量（与 mpv client.h mpv_format 枚举对齐）──
    public static final class MpvFormat {
        public static final int MPV_FORMAT_NONE    = 0;
        public static final int MPV_FORMAT_STRING  = 1;
        public static final int MPV_FORMAT_FLAG    = 3;
        public static final int MPV_FORMAT_INT64   = 4;
        public static final int MPV_FORMAT_DOUBLE  = 5;
    }

    public static final class MpvEvent {
        public static final int MPV_EVENT_SHUTDOWN         = 1;
        public static final int MPV_EVENT_START_FILE       = 6;
        public static final int MPV_EVENT_END_FILE         = 7;
        public static final int MPV_EVENT_FILE_LOADED      = 8;
        public static final int MPV_EVENT_VIDEO_RECONFIG   = 17;
        public static final int MPV_EVENT_AUDIO_RECONFIG   = 18;
        public static final int MPV_EVENT_SEEK             = 20;
        public static final int MPV_EVENT_PLAYBACK_RESTART = 21;
    }

    public static final class MpvEndFileReason {
        public static final int MPV_END_FILE_REASON_EOF      = 0;
        public static final int MPV_END_FILE_REASON_STOP     = 2;
        public static final int MPV_END_FILE_REASON_QUIT     = 3;
        public static final int MPV_END_FILE_REASON_ERROR    = 4;
        public static final int MPV_END_FILE_REASON_REDIRECT = 5;
    }

    public static final class MpvError {
        public static final int MPV_ERROR_SUCCESS                    = 0;
        public static final int MPV_ERROR_EVENT_QUEUE_FULL           = -1;
        public static final int MPV_ERROR_NOMEM                      = -2;
        public static final int MPV_ERROR_UNINITIALIZED              = -3;
        public static final int MPV_ERROR_INVALID_PARAMETER          = -4;
        public static final int MPV_ERROR_OPTION_NOT_FOUND           = -5;
        public static final int MPV_ERROR_OPTION_FORMAT              = -6;
        public static final int MPV_ERROR_OPTION_ERROR               = -7;
        public static final int MPV_ERROR_PROPERTY_NOT_FOUND         = -8;
        public static final int MPV_ERROR_PROPERTY_FORMAT            = -9;
        public static final int MPV_ERROR_PROPERTY_UNAVAILABLE       = -10;
        public static final int MPV_ERROR_PROPERTY_ERROR             = -11;
        public static final int MPV_ERROR_COMMAND                    = -12;
        public static final int MPV_ERROR_LOADING_FAILED             = -13;
        public static final int MPV_ERROR_AO_INIT_FAILED             = -14;
        public static final int MPV_ERROR_VO_INIT_FAILED             = -15;
        public static final int MPV_ERROR_NOTHING_TO_PLAY            = -16;
        public static final int MPV_ERROR_GENERIC                    = -20;
    }

    // ── 观察者接口 ──
    public interface EventObserver {
        void eventProperty(String property);
        void eventProperty(String property, long value);
        void eventProperty(String property, boolean value);
        void eventProperty(String property, String value);
        void eventProperty(String property, double value);
        void event(int eventId);
        default void eventCommandReply(long requestId, int error) {}
        void eventEndFile(int reason, int error, @Nullable String errorString);
    }

    public interface LogObserver {
        void logMessage(String prefix, int level, String text);
    }
}
