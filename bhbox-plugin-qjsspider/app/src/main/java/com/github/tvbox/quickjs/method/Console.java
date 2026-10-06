package com.github.tvbox.quickjs.method;


import com.github.catvod.utils.LOG;
import com.whl.quickjs.wrapper.QuickJSContext;

public class Console implements QuickJSContext.Console {

    private static final String TAG = "quickjs";

    @Override
    public void log(String info) {
        LOG.d(TAG,info);
    }

    @Override
    public void info(String info) {
        LOG.i(TAG,info);
    }

    @Override
    public void warn(String info) {
        LOG.w(TAG,info);
    }

    @Override
    public void error(String info) {
        LOG.e(TAG,info);
    }
}