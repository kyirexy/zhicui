package com.videocapsule.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

@CapacitorPlugin(
    name = "DouyinBridge",
    permissions = {
        @Permission(
            alias = "legacyStorage",
            strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }
        )
    }
)
public class DouyinBridgePlugin extends Plugin {

    private static final String PNG_PREFIX = "data:image/png;base64,";
    private static final int MAX_QR_BYTES = 2 * 1024 * 1024;
    private static final String DOUYIN_PACKAGE = "com.ss.android.ugc.aweme";

    @PluginMethod
    public void saveLoginQr(PluginCall call) {
        if (
            Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            && getPermissionState("legacyStorage") != PermissionState.GRANTED
        ) {
            requestPermissionForAlias(
                "legacyStorage",
                call,
                "legacyStoragePermissionCallback"
            );
            return;
        }
        saveLoginQrToGallery(call);
    }

    @PermissionCallback
    public void legacyStoragePermissionCallback(PluginCall call) {
        if (getPermissionState("legacyStorage") != PermissionState.GRANTED) {
            call.reject("没有相册写入权限，可改用另一台设备扫码或在桌面端绑定");
            return;
        }
        saveLoginQrToGallery(call);
    }

    @PluginMethod
    public void openDouyin(PluginCall call) {
        Intent intent = getContext()
            .getPackageManager()
            .getLaunchIntentForPackage(DOUYIN_PACKAGE);
        boolean installed = intent != null;

        if (intent == null) {
            intent = new Intent(
                Intent.ACTION_VIEW,
                Uri.parse("https://www.douyin.com/")
            );
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        try {
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("installed", installed);
            result.put("destination", installed ? "app" : "web");
            call.resolve(result);
        } catch (Exception error) {
            call.reject("暂时无法打开抖音，请手动打开抖音扫一扫", error);
        }
    }

    private void saveLoginQrToGallery(PluginCall call) {
        String dataUrl = call.getString("dataUrl", "");
        if (!dataUrl.startsWith(PNG_PREFIX)) {
            call.reject("二维码图片格式无效");
            return;
        }

        byte[] pngBytes;
        try {
            pngBytes = Base64.decode(
                dataUrl.substring(PNG_PREFIX.length()),
                Base64.DEFAULT
            );
        } catch (IllegalArgumentException error) {
            call.reject("二维码图片解码失败", error);
            return;
        }
        if (pngBytes.length == 0 || pngBytes.length > MAX_QR_BYTES) {
            call.reject("二维码图片大小无效");
            return;
        }

        String fileName = "zhicui-douyin-login-" + System.currentTimeMillis() + ".png";
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveThroughMediaStore(pngBytes, fileName);
            } else {
                saveToLegacyPictures(pngBytes, fileName);
            }
            JSObject result = new JSObject();
            result.put("saved", true);
            result.put("fileName", fileName);
            result.put("album", "Pictures/Zhicui");
            call.resolve(result);
        } catch (Exception error) {
            call.reject("保存二维码到相册失败，请重试或改用另一台设备扫码", error);
        }
    }

    private void saveThroughMediaStore(byte[] pngBytes, String fileName)
        throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName);
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
        values.put(
            MediaStore.Images.Media.RELATIVE_PATH,
            Environment.DIRECTORY_PICTURES + "/Zhicui"
        );
        values.put(MediaStore.Images.Media.IS_PENDING, 1);

        Uri imageUri = resolver.insert(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            values
        );
        if (imageUri == null) {
            throw new IllegalStateException("MediaStore did not return an image URI");
        }

        boolean complete = false;
        try (OutputStream output = resolver.openOutputStream(imageUri)) {
            if (output == null) {
                throw new IllegalStateException("Cannot open MediaStore output");
            }
            output.write(pngBytes);
            output.flush();
            complete = true;
        } finally {
            if (!complete) {
                resolver.delete(imageUri, null, null);
            }
        }

        ContentValues published = new ContentValues();
        published.put(MediaStore.Images.Media.IS_PENDING, 0);
        resolver.update(imageUri, published, null, null);
    }

    @SuppressWarnings("deprecation")
    private void saveToLegacyPictures(byte[] pngBytes, String fileName)
        throws Exception {
        File album = new File(
            Environment.getExternalStoragePublicDirectory(
                Environment.DIRECTORY_PICTURES
            ),
            "Zhicui"
        );
        if (!album.exists() && !album.mkdirs()) {
            throw new IllegalStateException("Cannot create gallery directory");
        }

        File destination = new File(album, fileName);
        try (OutputStream output = new FileOutputStream(destination)) {
            output.write(pngBytes);
            output.flush();
        }
        MediaScannerConnection.scanFile(
            getContext(),
            new String[] { destination.getAbsolutePath() },
            new String[] { "image/png" },
            null
        );
    }
}
