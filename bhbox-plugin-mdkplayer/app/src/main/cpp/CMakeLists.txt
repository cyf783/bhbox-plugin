# bh.box.plugin.mdk JNI 层（libmdk-jni.so）
# 链接 jniLibs 内预编 libmdk.so（mdk-sdk v0.39.0），头文件在 include/mdk/
cmake_minimum_required(VERSION 3.22.1)
project(mdkplayer CXX)

set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)
# 16KB page-size 设备兼容
add_link_options(-Wl,-z,max-page-size=16384)

set(MDK_INCLUDE ${CMAKE_CURRENT_SOURCE_DIR}/include)
set(MDK_LIB ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libmdk.so)

add_library(mdk SHARED IMPORTED)
set_target_properties(mdk PROPERTIES IMPORTED_LOCATION ${MDK_LIB})

add_library(mdk-jni SHARED
        jmi/jmi.cpp
        MDKPlayerJNI.cpp)

target_include_directories(mdk-jni PRIVATE ${MDK_INCLUDE})
target_link_libraries(mdk-jni PRIVATE mdk -llog -landroid)
