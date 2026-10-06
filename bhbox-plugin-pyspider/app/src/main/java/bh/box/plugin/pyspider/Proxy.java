package bh.box.plugin.pyspider;


import com.github.catvod.Init;

public class Proxy {

    public static int getPort() {
        return Init.getServerPort();
    }
    public static String getUrl(boolean local) {
        return Init.getServerAddress(local) + "proxy";
    }
}
