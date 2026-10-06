package bh.box.plugin.exo;

import android.text.TextUtils;

import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.common.util.Util;

import java.util.Locale;

@UnstableApi
public class ExoTrackNameProvider {

    public ExoTrackNameProvider() {
    }

    public String getTrackName(Format format) {
        String trackName;
        int trackType = inferPrimaryTrackType(format);
        if (trackType == C.TRACK_TYPE_VIDEO) {
            trackName =
                    joinWithSeparator(
                            buildRoleString(format), buildResolutionString(format), buildBitrateString(format));
        } else if (trackType == C.TRACK_TYPE_AUDIO) {
            trackName =
                    joinWithSeparator(
                            buildLanguageOrLabelString(format),
                            buildAudioChannelString(format),
                            buildBitrateString(format));
        } else {
            trackName = buildLanguageOrLabelString(format);
        }
        return trackName.length() == 0 ? "Unknown" : trackName;
    }

    public String getTrackLanguage(Format format) {
        return buildLanguageString(format);
    }

    private String buildResolutionString(Format format) {
        int width = format.width;
        int height = format.height;
        return width == Format.NO_VALUE || height == Format.NO_VALUE
                ? ""
                : String.format(Locale.US, "%d × %d", width, height);
    }

    private String buildBitrateString(Format format) {
        int bitrate = format.bitrate;
        return bitrate == Format.NO_VALUE
                ? ""
                : String.format(Locale.US, "%.2f Mbps", bitrate / 1000000f);
    }

    private String buildAudioChannelString(Format format) {
        int channelCount = format.channelCount;
        if (channelCount == Format.NO_VALUE || channelCount < 1) {
            return "";
        }
        switch (channelCount) {
            case 1:
                return "Mono";
            case 2:
                return "Stereo";
            case 6:
            case 7:
                return "5.1 Surround Sound";
            case 8:
                return "7.1 Surround Sound";
            default:
                return "Surround Sound";
        }
    }

    private String buildLanguageOrLabelString(Format format) {
        String languageAndRole =
                joinWithSeparator(buildLanguageString(format), buildRoleString(format));
        return TextUtils.isEmpty(languageAndRole) ? buildLabelString(format) : languageAndRole+"："+buildLabelString(format);
    }

    private String buildLabelString(Format format) {
        return TextUtils.isEmpty(format.label) ? "" : format.label;
    }

    private String buildLanguageString(Format format) {
        @Nullable String language = format.language;
        if (TextUtils.isEmpty(language) || C.LANGUAGE_UNDETERMINED.equals(language)) {
            return "";
        }
        Locale languageLocale =
                Util.SDK_INT >= 21 ? Locale.forLanguageTag(language) : new Locale(language);
        Locale displayLocale =
                Util.SDK_INT >= 24 ? Locale.getDefault(Locale.Category.DISPLAY) : Locale.getDefault();
        String languageName = languageLocale.getDisplayName(displayLocale);
        if (TextUtils.isEmpty(languageName)) {
            return "";
        }
        try {
            // Capitalize the first letter. See: https://github.com/google/ExoPlayer/issues/9452.
            int firstCodePointLength = languageName.offsetByCodePoints(0, 1);
            return languageName.substring(0, firstCodePointLength).toUpperCase(displayLocale)
                    + languageName.substring(firstCodePointLength);
        } catch (IndexOutOfBoundsException e) {
            // Should never happen, but return the unmodified language name if it does.
            return languageName;
        }
    }

    private String buildRoleString(Format format) {
        String roles = "";
        if ((format.roleFlags & C.ROLE_FLAG_ALTERNATE) != 0) {
            roles = "Alternate";
        }
        if ((format.roleFlags & C.ROLE_FLAG_SUPPLEMENTARY) != 0) {
            roles = joinWithSeparator(roles, "Supplementary");
        }
        if ((format.roleFlags & C.ROLE_FLAG_COMMENTARY) != 0) {
            roles = joinWithSeparator(roles, "Commentary");
        }
        if ((format.roleFlags & (C.ROLE_FLAG_CAPTION | C.ROLE_FLAG_DESCRIBES_MUSIC_AND_SOUND)) != 0) {
            roles = joinWithSeparator(roles, "CC");
        }
        return roles;
    }

    private String joinWithSeparator(String... items) {
        String itemList = "";
        for (String item : items) {
            if (item.length() > 0) {
                if (TextUtils.isEmpty(itemList)) {
                    itemList = item;
                } else {
                    itemList = itemList + "，" + item;
                }
            }
        }
        return itemList;
    }

    private static int inferPrimaryTrackType(Format format) {
        int trackType = MimeTypes.getTrackType(format.sampleMimeType);
        if (trackType != C.TRACK_TYPE_UNKNOWN) {
            return trackType;
        }
        if (MimeTypes.getVideoMediaMimeType(format.codecs) != null) {
            return C.TRACK_TYPE_VIDEO;
        }
        if (MimeTypes.getAudioMediaMimeType(format.codecs) != null) {
            return C.TRACK_TYPE_AUDIO;
        }
        if (format.width != Format.NO_VALUE || format.height != Format.NO_VALUE) {
            return C.TRACK_TYPE_VIDEO;
        }
        if (format.channelCount != Format.NO_VALUE || format.sampleRate != Format.NO_VALUE) {
            return C.TRACK_TYPE_AUDIO;
        }
        return C.TRACK_TYPE_UNKNOWN;
    }
}
