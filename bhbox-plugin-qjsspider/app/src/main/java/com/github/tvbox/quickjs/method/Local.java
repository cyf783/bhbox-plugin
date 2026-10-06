package com.github.tvbox.quickjs.method;

import android.text.TextUtils;

import androidx.annotation.Keep;

import com.github.catvod.utils.Cache;
import com.whl.quickjs.wrapper.JSMethod;

public class Local {

    private String getKey(String rule, String key) {
        return "cache_" + (TextUtils.isEmpty(rule) ? "" : rule + "_") + key;
    }

    @Keep
    @JSMethod
    public String get(String rule, String key) {
        return Cache.getString(getKey(rule, key));
    }

    @Keep
    @JSMethod
    public void set(String rule, String key, String value) {
        Cache.put(getKey(rule, key), value);
    }

    @Keep
    @JSMethod
    public void delete(String rule, String key) {
        Cache.delete(getKey(rule, key));
    }
}
