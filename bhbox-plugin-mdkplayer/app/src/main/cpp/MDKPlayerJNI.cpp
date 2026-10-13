/*
 * bh.box.plugin.mdk JNI 层。
 * 基于 mdk-android demo（MDKPlayerJNI.cpp，WangBin）扩展：
 * 1. nativeSetMedia 增加 headers（经 property "avio.headers" 注入）
 * 2. onEvent error → MEDIA_ERROR（带 detail 文案）；MediaStatus::Loaded → 视频宽高事件
 * 3. 新增 nativeSetDecoders / nativeSetVolume / nativeSetSpeed / nativeSetLogLevel
 * 4. 删除 demo 的 vulkan/tunnel/PlayList/NextMedia/ColorSpace/AudioBackends 分支
 * 事件码与 Java 侧 bh.box.plugin.mdk.MdkPlayer 常量对齐。
 */
#include "jmi/jmi.h"
#include <jni.h>
#include <android/log.h>
#include <android/native_window.h>
#include <android/native_window_jni.h>
#include <mdk/Player.h>
#include <mdk/MediaInfo.h>
#include <string>
#include <vector>
#include <set>

using namespace MDK_NS;

enum { // 与 MdkPlayer.java 事件常量对齐
    MEDIA_ERROR = -1,
    MEDIA_INFO = 0,
    MEDIA_PREPARED = 1,
    MEDIA_PLAYBACK_COMPLETE = 2,
    MEDIA_BUFFERING_UPDATE = 3,
    MEDIA_VIDEO_SIZE_CHANGED = 4,
};

enum {
    MEDIA_INFO_BUFFERING_START = 701,
    MEDIA_INFO_BUFFERING_END   = 702,
    MEDIA_ERROR_TIMED_OUT      = -110,
};

static void PostEvent(std::weak_ptr<jobject> wp, int what, int arg1 = 0, int arg2 = 0, jobject msg = nullptr)
{
    auto sp = wp.lock();
    if (!sp)
        return;
    auto obj = *sp;
    JNIEnv* env = jmi::getEnv();
    static jclass sClass = nullptr;
    static jmethodID sMethod = nullptr;
    if (!sMethod) {
        jclass clazz = env->GetObjectClass(obj);
        sClass = (jclass)env->NewGlobalRef(clazz);
        sMethod = env->GetStaticMethodID(sClass, "postEventFromNative", "(Ljava/lang/Object;IIILjava/lang/Object;)V");
    }
    env->CallStaticVoidMethod(sClass, sMethod, obj, what, arg1, arg2, msg);
    if (msg)
        env->DeleteLocalRef(msg);
}

struct PlayerRef {
    ~PlayerRef() {
        delete player;
        if (surface)
            jmi::getEnv()->DeleteGlobalRef(surface);
    }

    Player* player = new Player();
    std::shared_ptr<jobject> spobj;
    jobject surface = nullptr; // GlobalRef
    int width = 0;
    int height = 0;
    std::vector<std::string> decoders = {"AMediaCodec:dv=0:acquire=latest:ndk_codec=1:java=0:copy=0:surface=1:image=1:async=1:low_latency=1", "FFmpeg"};
};

static Player* get(jlong obj_ptr) {
    return reinterpret_cast<PlayerRef*>(obj_ptr)->player;
}

// 轨道行格式："type\tindex\tlanguage\tcodec"，type 为 MDK_MediaType（Video=0/Audio=1/Subtitle=3）
template<typename StreamInfo>
static std::string TrackRow(MDK_MediaType type, size_t i, const StreamInfo& s)
{
    std::string lang;
    auto it = s.metadata.find("language");
    if (it != s.metadata.end())
        lang = it->second;
    return std::to_string((int)type) + "\t" + std::to_string(i) + "\t" + lang + "\t" + (s.codec.codec ? s.codec.codec : "");
}

static void ApplySurface(PlayerRef* r)
{
    auto p = r->player;
    p->setDecoders(MediaType::Video, r->decoders);
    p->updateNativeSurface(r->surface, r->width, r->height);
}

extern "C" {

JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void* reserved)
{
    setLogHandler([](LogLevel v, const char* msg){
        if (v < LogLevel::Info)
            __android_log_print(ANDROID_LOG_WARN, "MDK-JNI", "%s", msg);
        else
            __android_log_print(ANDROID_LOG_DEBUG, "MDK-JNI", "%s", msg);
    });
    SetGlobalOption("log", LogLevel::Off); // 默认静音，MdkPlugin.init() 按 plugin.json 参数调整
    __android_log_print(ANDROID_LOG_DEBUG, "MDK-JNI", "JNI_OnLoad");
    JNIEnv* env = nullptr;
    if (vm->GetEnv((void**) &env, JNI_VERSION_1_4) != JNI_OK || !env) {
        __android_log_print(ANDROID_LOG_ERROR, "MDK-JNI", "GetEnv for JNI_VERSION_1_4 failed");
        return -1;
    }
    jmi::javaVM(vm);
    return JNI_VERSION_1_4;
}

#define MDK_JNI_FUNC(Name) Java_bh_box_plugin_mdk_##Name
#define MDK_JNI(Return, Name, ...) \
    JNIEXPORT Return JNICALL MDK_JNI_FUNC(Name) (JNIEnv *env, jobject thiz, jlong obj_ptr, ##__VA_ARGS__)

MDK_JNI(jlong, MdkPlayer_nativeCreate)
{
    auto pr = new PlayerRef();
    jobject objr = env->NewGlobalRef(thiz);
    pr->spobj = std::shared_ptr<jobject>(new jobject(objr), [](jobject* p){
        jmi::getEnv()->DeleteGlobalRef(*p);
        delete p;
    });
    auto p = pr->player;
    // 宿主五种比例模式（默认/16:9/4:3/填充/原始）全部由 TextureRenderView 的 view 几何实现，
    // 内核须拉伸填满 surface（IgnoreAspectRatio=0）；mdk 默认 KeepAspectRatio 会 letterbox 回
    // 原生比例，导致强制比例模式画面内容不变、看似"一闪还原"
    p->setAspectRatio(0.0f);
    std::weak_ptr<jobject> w = pr->spobj;
    p->setTimeout(20000, [w](int64_t t){
        PostEvent(w, MEDIA_ERROR, MEDIA_ERROR_TIMED_OUT);
        return true;
    });
    p->onStateChanged([w, p](PlaybackState s){
        if (s == State::Stopped) {
            if (test_flag(p->mediaStatus() & MediaStatus::End))
                PostEvent(w, MEDIA_PLAYBACK_COMPLETE);
        }
    });
    p->onMediaStatus([w, p](MediaStatus oldVal, MediaStatus newVal){
        if (flags_added(oldVal, newVal, MediaStatus::Buffering))
            PostEvent(w, MEDIA_INFO, MEDIA_INFO_BUFFERING_START);
        if (flags_removed(oldVal, newVal, MediaStatus::Buffering))
            PostEvent(w, MEDIA_INFO, MEDIA_INFO_BUFFERING_END);
        if (flags_added(oldVal, newVal, MediaStatus::Prepared))
            PostEvent(w, MEDIA_PREPARED);
        if (flags_added(oldVal, newVal, MediaStatus::Loaded)) { // mediaInfo 此刻可用
            const auto& mi = p->mediaInfo();
            if (!mi.video.empty())
                PostEvent(w, MEDIA_VIDEO_SIZE_CHANGED, mi.video[0].codec.width, mi.video[0].codec.height);
            if (!mi.subtitle.empty())
                p->setActiveTracks(MediaType::Subtitle, {0}); // mdk 默认不激活字幕轨，须显式启动解码（关字幕走 deselectTrack 空集合）
            PostEvent(w, MEDIA_PREPARED); // 回退方案（§4.3）：prepare() 模式下 Prepared 标志不触发宿主 UI，改绑 Loaded
        }
        if (flags_added(oldVal, newVal, MediaStatus::Invalid))
            PostEvent(w, MEDIA_ERROR, -1);
        return true;
    });
    p->onEvent([w](const MediaEvent& e){
        if (e.category == "reader.buffering") {
            PostEvent(w, MEDIA_BUFFERING_UPDATE, (int)e.error);
            return false;
        }
        if (e.error < 0) { // 加载/解码错误，detail 为错误描述
            JNIEnv* env = jmi::getEnv();
            jstring msg = e.detail.empty() ? nullptr : env->NewStringUTF(e.detail.c_str());
            PostEvent(w, MEDIA_ERROR, (int)e.error, 0, msg);
        }
        return false;
    });
    // 字幕文本走 nativeSubtitleText 主动查询（onSubtitleText 回调依赖渲染管线，"subtitle"=0 时不触发）
    putenv("GL_YUV_SAMPLER=1");
    return jlong(pr);
}

MDK_JNI(void, MdkPlayer_nativeDestroy)
{
    delete (PlayerRef*)obj_ptr;
}

MDK_JNI(void, MdkPlayer_nativeSetMedia, jstring url, jstring headers)
{
    auto p = get(obj_ptr);
    // headers 以 ffmpeg AVIOContext "headers" 选项格式注入（\r\n 分隔的头行）；换源无 headers 时显式清空
    const char* h = headers ? env->GetStringUTFChars(headers, nullptr) : "";
    p->setProperty("avio.headers", h);
    if (headers)
        env->ReleaseStringUTFChars(headers, h);
    if (!url) {
        p->setMedia(nullptr);
        return;
    }
    const char* s = env->GetStringUTFChars(url, nullptr);
    p->setMedia(s);
    env->ReleaseStringUTFChars(url, s);
}

MDK_JNI(void, MdkPlayer_nativeSetState, int state)
{
    get(obj_ptr)->set((State)state);
}

MDK_JNI(jint, MdkPlayer_nativeState)
{
    return jint(get(obj_ptr)->state());
}

MDK_JNI(void, MdkPlayer_nativeSetSurface, jobject s, int w, int h)
{
    if (!obj_ptr)
        return; // surfaceDestroyed 时 player 可能已释放
    auto r = reinterpret_cast<PlayerRef*>(obj_ptr);
    if (r->surface) {
        env->DeleteGlobalRef(r->surface);
        r->surface = nullptr;
    }
    if (s)
        r->surface = env->NewGlobalRef(s);
    r->width = w;
    r->height = h;
    ApplySurface(r);
}

// 同一 surface 的尺寸变化：fromSurface 仅查询当前 buffer 尺寸后立即 release（指针不传给
// mdk，避免新包装指针触发 NativeHandle 变化），再走 resizeSurface 轻量路径只更新尺寸
MDK_JNI(void, MdkPlayer_nativeResizeSurface)
{
    if (!obj_ptr)
        return;
    auto r = reinterpret_cast<PlayerRef*>(obj_ptr);
    if (!r->surface)
        return;
    ANativeWindow* win = ANativeWindow_fromSurface(env, r->surface);
    if (!win)
        return;
    int w = ANativeWindow_getWidth(win);
    int h = ANativeWindow_getHeight(win);
    ANativeWindow_release(win);
    if (w > 0 && h > 0)
        r->player->resizeSurface(w, h);
}

MDK_JNI(jlong, MdkPlayer_nativeGetDuration)
{
    if (!obj_ptr)
        return 0;
    return (jlong)get(obj_ptr)->mediaInfo().duration;
}

MDK_JNI(jlong, MdkPlayer_nativePosition)
{
    if (!obj_ptr)
        return 0;
    return (jlong)get(obj_ptr)->position();
}

MDK_JNI(void, MdkPlayer_nativeSeek, jlong ms)
{
    if (!obj_ptr)
        return;
    get(obj_ptr)->seek((int64_t)ms);
}

MDK_JNI(void, MdkPlayer_nativeSetSpeed, jfloat speed)
{
    get(obj_ptr)->setPlaybackRate(speed);
}

MDK_JNI(void, MdkPlayer_nativeSetProperty, jstring key, jstring value)
{
    if (!key || !value)
        return;
    const char* k = env->GetStringUTFChars(key, nullptr);
    const char* v = env->GetStringUTFChars(value, nullptr);
    get(obj_ptr)->setProperty(k, v);
    env->ReleaseStringUTFChars(key, k);
    env->ReleaseStringUTFChars(value, v);
}

MDK_JNI(void, MdkPlayer_nativeSetVolume, jfloat left, jfloat right)
{
    get(obj_ptr)->setVolume((left + right) / 2.0f); // mdk 仅有整体音量，取左右均值
}

MDK_JNI(void, MdkPlayer_nativeSetDecoders, jobjectArray names)
{
    auto r = reinterpret_cast<PlayerRef*>(obj_ptr);
    jsize len = env->GetArrayLength(names);
    std::vector<std::string> decoders;
    for (jsize i = 0; i < len; ++i) {
        auto si = (jstring)env->GetObjectArrayElement(names, i);
        const char* s = env->GetStringUTFChars(si, nullptr);
        decoders.push_back(s);
        env->ReleaseStringUTFChars(si, s);
        env->DeleteLocalRef(si);
    }
    if (decoders.empty())
        return;
    r->decoders = decoders; // 记录用户选择，ApplySurface 换 surface 时沿用
    r->player->setDecoders(MediaType::Video, r->decoders);
}

MDK_JNI(jobjectArray, MdkPlayer_nativeGetTrackInfo)
{
    if (!obj_ptr)
        return nullptr;
    const auto& mi = get(obj_ptr)->mediaInfo();
    std::vector<std::string> rows;
    for (size_t i = 0; i < mi.audio.size(); ++i) rows.push_back(TrackRow(MDK_MediaType_Audio, i, mi.audio[i]));
    for (size_t i = 0; i < mi.video.size(); ++i) rows.push_back(TrackRow(MDK_MediaType_Video, i, mi.video[i]));
    for (size_t i = 0; i < mi.subtitle.size(); ++i) rows.push_back(TrackRow(MDK_MediaType_Subtitle, i, mi.subtitle[i]));
    jclass cls = env->FindClass("java/lang/String");
    jobjectArray arr = env->NewObjectArray((jsize)rows.size(), cls, nullptr);
    for (jsize i = 0; i < (jsize)rows.size(); ++i)
        env->SetObjectArrayElement(arr, i, env->NewStringUTF(rows[i].c_str()));
    env->DeleteLocalRef(cls);
    return arr;
}

MDK_JNI(void, MdkPlayer_nativeSetTrack, jint type, jint index)
{
    if (!obj_ptr)
        return;
    std::set<int> tracks; // 空集合 = 取消该类型全部激活轨（关字幕）
    if (index >= 0)
        tracks.insert(index);
    get(obj_ptr)->setActiveTracks((MediaType)type, tracks);
}

MDK_JNI(jstring, MdkPlayer_nativeSubtitleText)
{
    if (!obj_ptr)
        return nullptr;
    auto s = get(obj_ptr)->subtitleText(-1, 0); // -1: 取当前文本；渲染关闭（"subtitle"=0）时仍可用
    return s.empty() ? nullptr : env->NewStringUTF(s.c_str());
}

// static native（无 obj_ptr），全局日志级别
JNIEXPORT void JNICALL Java_bh_box_plugin_mdk_MdkPlayer_nativeSetLogLevel(JNIEnv*, jclass, jint level)
{
    SetGlobalOption("log", (LogLevel)level);
}
}
