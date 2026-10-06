package bh.box.plugin.extractor.thunder;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import android.text.TextUtils;

import com.github.catvod.Init;
import com.github.catvod.exception.AppException;
import com.github.catvod.plugin.IExtractorPlugin;
import com.github.catvod.plugin.bean.UrlBean;
import com.github.catvod.utils.Path;
import com.xunlei.downloadlib.XLDownloadManager;
import com.xunlei.downloadlib.XLTaskHelper;
import com.xunlei.downloadlib.android.XLUtil;
import com.xunlei.downloadlib.parameter.TorrentFileInfo;
import com.xunlei.downloadlib.parameter.TorrentInfo;
import com.xunlei.downloadlib.parameter.XLTaskInfo;

import java.io.File;
import java.util.ArrayList;
import java.util.Random;

public class ThunderExtractorPlugin implements IExtractorPlugin {

    public static final String ID = "bh.box.plugin.extractor.thunder";

    private Boolean isInit = false;
    private String cacheRoot = "";
    private long currentTask = 0L;
    private String localPath = "";
    private String name = "";
    private String task_url = "";
    private ArrayList<TorrentFileInfo> torrentFileInfoArrayList = null;

    private ArrayList<UrlBean.InfoBean> playList = null;
    private ArrayList<String> ed2kList = null;

    private void initThunder() {
        if(!isInit){
            isInit=true;
            // fake deviceId and Mac
            SharedPreferences sharedPreferences = Init.context().getSharedPreferences("rand_thunder_id", Context.MODE_PRIVATE);
            String imei = sharedPreferences.getString("imei", null);
            String mac = sharedPreferences.getString("mac", null);
            if (imei == null) {
                imei = randomImei();
                sharedPreferences.edit().putString("imei", imei).commit();
            }
            if (mac == null) {
                mac = randomMac();
                sharedPreferences.edit().putString("mac", mac).commit();
            }

            XLUtil.mIMEI = imei;
            XLUtil.isGetIMEI = true;
            XLUtil.mMAC = mac;
            XLUtil.isGetMAC = true;
            String cd3 = "cee25055f125a2fde0";
            String base64Decode = "axzNjAwMQ^^yb==0^852^083dbcff^";
            String substring = base64Decode.substring(1);
            String substring2 = cd3.substring(0, cd3.length() - 1);
            String cd = substring + substring2;
            XLTaskHelper.init(Init.context(), cd, "21.01.07.800002");
            cacheRoot = Path.thunder().getAbsolutePath();
        }
    }
    @Override
    public void stop(boolean bool) {
        if (currentTask > 0) {
            XLTaskHelper.instance().stopTask(currentTask);
            currentTask = 0L;
        }
        if(bool){
            torrentFileInfoArrayList = null;
            // del cache file
            File cache = new File(cacheRoot);
            recursiveDelete(cache);
            if (!cache.exists())
                cache.mkdirs();
        }
    }

    @Override
    public void install() {}

    @Override
    public void init() {}

    @Override
    public void uninstall() { stop(true); }

    @Override
    public UrlBean parse(UrlBean urls) {
        initThunder();
        stop(true);
        torrentFileInfoArrayList=new ArrayList<>();
        playList=new ArrayList<>();
        ed2kList=new ArrayList<>();
        UrlBean out = new UrlBean();
        out.infoList = new ArrayList<>();
        for (UrlBean.UrlInfo info : urls.infoList) {
            if (info == null || info.beanList == null) continue;
            boolean hit = false;
            for (UrlBean.InfoBean bean : info.beanList) {
                boolean isParse=false;
                String url = bean.url;
                if (isMagnet(url) || isThunder(url) || isTorrent(url)) {
                    url = isThunder(url) ? XLDownloadManager.getInstance().parserThunderUrl(url) : url;
                    String fileName = XLTaskHelper.instance().getFileName(url);
                    File cache = new File(cacheRoot + File.separator + fileName);
                    try {
                        if (currentTask > 0) {
                            XLTaskHelper.instance().stopTask(currentTask);
                            currentTask = 0L;
                        }
                        currentTask = isMagnet(url) ?
                                XLTaskHelper.instance().addMagentTask(url, cacheRoot, fileName) :
                                XLTaskHelper.instance().addThunderTask(url, cacheRoot, fileName);
                    } catch (Exception exception) {
                        exception.printStackTrace();
                        currentTask = 0;
                    }
                    if (currentTask <= 0) {
                        continue;
                    }
                    int count = 30;
                    outerLoop:
                    while (true) {
                        count--;
                        if (count <= 0) {
                            break;
                        }
                        XLTaskInfo taskInfo = XLTaskHelper.instance().getTaskInfo(currentTask);
                        if(taskInfo!=null){
                            switch (taskInfo.mTaskStatus) {
                                case 2: {
                                    try {
                                        TorrentInfo torrentInfo = XLTaskHelper.instance().getTorrentInfo(cache.getAbsolutePath());
                                        if (torrentInfo == null || TextUtils.isEmpty(torrentInfo.mInfoHash)) {

                                        } else {
                                            TorrentFileInfo[] mSubFileInfo = torrentInfo.mSubFileInfo;
                                            if (mSubFileInfo != null) {
                                                for (TorrentFileInfo sub : mSubFileInfo) {
                                                    if (isMedia(sub.mFileName) && sub.mFileSize > 1048576L * 30) {
                                                        sub.torrentPath = cache.getAbsolutePath();
                                                        playList.add(new UrlBean.InfoBean(sub.mFileName, "tvbox-torrent:" + torrentFileInfoArrayList.size()));
                                                        torrentFileInfoArrayList.add(sub);
                                                    }
                                                }
                                                isParse=true;
                                                break outerLoop;
                                            }
                                        }
                                    } catch (Throwable throwable) {
                                        throwable.printStackTrace();
                                    }
                                }
                                case 3: {
                                    break outerLoop;
                                }
                            }
                        }
                        SystemClock.sleep(100);
                    }
                }else if(!isJp(url)){
                    if(isThunder(url))url=XLDownloadManager.getInstance().parserThunderUrl(url);
                    if(isNetworkDownloadTask(url)){
                        task_url=url;
                        if(TextUtils.isEmpty(task_url)){
                            continue;
                        }
                        name = XLTaskHelper.instance().getFileName(task_url);
                        playList.add(new UrlBean.InfoBean(name, "tvbox-oth:" + ed2kList.size()));
                        ed2kList.add(task_url);
                        isParse=true;
                    }
                }
                if (!isParse)playList.add(new UrlBean.InfoBean(bean.name, bean.url));
                else hit = true;
            }
            if (hit && !playList.isEmpty()) {
                UrlBean.UrlInfo outInfo = new UrlBean.UrlInfo();
                outInfo.flag = info.flag;
                outInfo.beanList = new ArrayList<>(playList);
                out.infoList.add(outInfo);
            } else {
                out.infoList.add(info);
            }
            playList.clear();
        }
        return out;
    }

    @Override
    public String getUrl(String url) throws AppException {
        init();
        if (url.startsWith("tvbox-torrent:")&&torrentFileInfoArrayList!=null) {
            int idx = Integer.parseInt(url.substring(14));
            TorrentFileInfo info = torrentFileInfoArrayList.get(idx);
            if (currentTask > 0) {
                XLTaskHelper.instance().stopTask(currentTask);
                currentTask = 0L;
            }
            String torrentName = new File(info.torrentPath).getName();
            String cache = cacheRoot + File.separator + torrentName.substring(0, torrentName.lastIndexOf("."));
            currentTask = XLTaskHelper.instance().addTorrentTask(info.torrentPath, cache, info.mFileIndex);
            if (currentTask < 0)
                throw new AppException("下载出错");
            while (true) {
                XLTaskInfo taskInfo = XLTaskHelper.instance().getBtSubTaskInfo(currentTask, info.mFileIndex).mTaskInfo;
                switch (taskInfo.mTaskStatus) {
                    case 3:
                        throw new AppException(errorInfo(taskInfo.mErrorCode));
                    case 1:
                    case 4: // 下载中
                    case 2: // 下载完成
                        return XLTaskHelper.instance().getLoclUrl(cache + File.separator + info.mFileName);
                }
                SystemClock.sleep(300);
            }
        }

        if (url.startsWith("tvbox-oth:")) {
            int idx = Integer.parseInt(url.substring(10));
            task_url=ed2kList.get(idx);
            name = XLTaskHelper.instance().getFileName(task_url);
            localPath = (new File(cacheRoot+File.separator+"temp", getFileNameWithoutExt(name)))+"/";
            currentTask = XLTaskHelper.instance().addThunderTask(task_url, localPath, null);
            while (true) {
                String playUrl=getPlayUrl();
                if(playUrl != null && !playUrl.isEmpty()){
                    return playUrl;
                }
                SystemClock.sleep(300);
            }
        }

        if ((!isJp(url))&&(isEd2k(url)||isFtp(url))){
            if (currentTask > 0) {
                XLTaskHelper.instance().stopTask(currentTask);
                currentTask = 0L;
            }
            task_url=url;
            name = XLTaskHelper.instance().getFileName(task_url);
            localPath = (new File(cacheRoot+File.separator+"temp", getFileNameWithoutExt(name)))+"/";
            currentTask = XLTaskHelper.instance().addThunderTask(task_url, localPath, null);
            if (currentTask < 0)
                throw new AppException("下载出错");
            while (true) {
                String playUrl=getPlayUrl();
                if(!TextUtils.isEmpty(playUrl)){
                    return playUrl;
                }
                SystemClock.sleep(300);
            }
        }

        return url;
    }

    private String errorInfo(int code) {
        switch (code) {
            case 9125:
                return "文件名太长";
            case 111120:
                return "文件路径太长";
            case 111142:
                return "文件太小";
            case 111085:
                return "磁盘空间不足";
            case 111171:
                return "拒绝的网络连接";
            case 9301:
                return "缓冲区不足";
            case 114001:
            case 114004:
            case 114005:
            case 114006:
            case 114007:
            case 114011:
            case 9304:
            case 111154:
                return "版权限制：无权下载";
            case 114101:
                return "无效链接";
            default:
                return "ErrorCode=" + code;
        }
    }

    @Override
    public boolean canParse(String url) {
        if(isJp(url)){
            return false;
        }
        return isMagnet(url) || isThunder(url) || isTorrent(url) || isEd2k(url)||isFtp(url);
    }

    public boolean isJp(String url) {
        return url.startsWith("ftp://")&&url.contains("gbl.114s");
    }

    @Override
    public boolean canPlay(String url) {
        return (url.startsWith("tvbox-torrent:")&&torrentFileInfoArrayList!=null)
                || url.startsWith("tvbox-oth:")
                || ((!isJp(url))&&(isEd2k(url)||isFtp(url)));
    }

    private boolean isMagnet(String url) {
        return url.toLowerCase().startsWith("magnet:");
    }

    private boolean isThunder(String url) {
        return url.toLowerCase().startsWith("thunder");
    }

    private boolean isTorrent(String url) {
        return url.toLowerCase().split(";")[0].endsWith(".torrent");
    }

    private boolean isEd2k(String url) {
        return url.toLowerCase().startsWith("ed2k:");
    }

    private boolean isFtp(String url) {
        return url.toLowerCase().startsWith("ftp:");
    }

    private void recursiveDelete(File file) {
        if (!file.exists())
            return;
        if (file.isDirectory()) {
            for (File f : file.listFiles()) {
                recursiveDelete(f);
            }
        }
        file.delete();
    }

    private ArrayList<String> formats = new ArrayList<>();

    private boolean isMedia(String name) {
        if (formats.size() == 0) {
            formats.add(".rmvb");
            formats.add(".avi");
            formats.add(".mkv");
            formats.add(".flv");
            formats.add(".mp4");
            formats.add(".rm");
            formats.add(".vob");
            formats.add(".wmv");
            formats.add(".mov");
            formats.add(".3gp");
            formats.add(".asf");
            formats.add("mpg");
            formats.add("mpeg");
            formats.add("mpe");
        }
        for (String f : formats) {
            if (name.toLowerCase().endsWith(f))
                return true;

        }
        return false;
    }

    private String randomImei() {
        return randomString("0123456", 15);
    }

    private String randomMac() {
        return randomString("ABCDEF0123456", 12).toUpperCase();
    }

    private String randomString(String base, int length) {
        Random random = new Random();
        StringBuffer sb = new StringBuffer();
        for (int i = 0; i < length; i++) {
            int number = random.nextInt(base.length());
            sb.append(base.charAt(number));
        }
        return sb.toString();
    }

    private boolean isNetworkDownloadTask(String url){
        if(TextUtils.isEmpty(url)) return false;
        if(isFtp(url) || isEd2k(url)){
            return true;
        }else{
            return false;
        }
    }
    private String getPlayUrl(){
        if(currentTask != 0L){
            if(isNetworkDownloadTask(task_url)){
                return XLTaskHelper.instance().getLoclUrl(localPath + name);
            }
        }
        return null;
    }

    private static String getFileNameWithoutExt(String filePath) {
        if (TextUtils.isEmpty(filePath)) return "";
        String fileName = filePath;
        int p = fileName.lastIndexOf(File.separatorChar);
        if (p != -1) {
            fileName = fileName.substring(p + 1);
        }
        p = fileName.indexOf('.');
        if (p != -1) {
            fileName = fileName.substring(0, p);
        }
        return fileName;
    }
}
