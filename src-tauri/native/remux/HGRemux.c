// SPDX-License-Identifier: LGPL-2.1-or-later
// HGRemux is an independently replaceable wrapper around unmodified FFmpeg.
#include "HGRemux.h"
#include <libavformat/avformat.h>
#include <libavcodec/bsf.h>
#include <libavcodec/avcodec.h>
#include <libavutil/avutil.h>
#include <libavutil/mem.h>
#include <libavutil/opt.h>
#include <stdatomic.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <math.h>
#include <limits.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>

#define HG_MAX_STREAMS 16
#define HG_PREFETCH_BYTES (4 * 1024 * 1024)
#define HG_PACKET_BYTES (16 * 1024 * 1024)
#define HG_INTERLEAVE_BYTES (4 * 1024 * 1024)
#define HG_MAX_PACKETS 10000000ULL
#define HG_MAX_SECONDS (24 * 60 * 60)
#define HG_MAX_MANIFEST_BYTES (1024 * 1024)

struct HGRemuxJob {
    atomic_bool cancelled, running;
    atomic_uint progress;
    pthread_mutex_t error_lock;
    char error[192];
};
typedef struct {
    AVStream *input, *output;
    AVBSFContext *filter;
    AVCodecParserContext *parser;
    AVCodecContext *parser_codec;
    uint8_t *config;
    size_t config_size;
    int64_t last_dts, audio_anchor, audio_samples;
    bool ready;
    uint64_t written_packets;
} Track;
typedef struct Buffered {
    AVPacket *packet;
    struct Buffered *next;
} Buffered;
typedef struct {
    HGRemuxJob *job;
    AVFormatContext *input, *output;
    AVIOContext *output_io;
    Track tracks[HG_MAX_STREAMS];
    unsigned stream_count;
    int fd;
    char directory[PATH_MAX];
    char temporary[PATH_MAX];
    double duration;
    int64_t origin_us, end_us;
    uint64_t packet_count;
    Buffered *first, *last;
    size_t buffered_bytes, interleave_bytes;
} Pipeline;

// FFmpeg is private to this framework (only hg_remux_* symbols are exported).
// Suppress its default stderr logger so local paths never enter app logs.
static pthread_once_t ffmpeg_once = PTHREAD_ONCE_INIT;
static void configure_ffmpeg(void) { av_log_set_level(AV_LOG_QUIET); }

static bool cancelled(HGRemuxJob *job) {
    return atomic_load_explicit(&job->cancelled, memory_order_relaxed);
}
static int interrupted(void *opaque) { return cancelled((HGRemuxJob *)opaque); }
static HGRemuxResult fail(Pipeline *p, HGRemuxResult result, const char *stage, int error) {
    char detail[AV_ERROR_MAX_STRING_SIZE] = "";
    if (error < 0) av_strerror(error, detail, sizeof(detail));
    pthread_mutex_lock(&p->job->error_lock);
    snprintf(p->job->error, sizeof(p->job->error), "%s%s%s", stage, detail[0] ? ": " : "", detail);
    pthread_mutex_unlock(&p->job->error_lock);
    return cancelled(p->job) ? HG_REMUX_CANCELLED : result;
}
HGRemuxJob *hg_remux_job_create(void) {
    pthread_once(&ffmpeg_once, configure_ffmpeg);
    HGRemuxJob *job = calloc(1, sizeof(*job));
    if (!job) return NULL;
    atomic_init(&job->cancelled, false);
    atomic_init(&job->running, false);
    atomic_init(&job->progress, 0);
    if (pthread_mutex_init(&job->error_lock, NULL)) { free(job); return NULL; }
    return job;
}
void hg_remux_job_cancel(HGRemuxJob *job) { if (job) atomic_store(&job->cancelled, true); }
void hg_remux_job_destroy(HGRemuxJob *job) {
    if (!job) return;
    pthread_mutex_destroy(&job->error_lock);
    free(job);
}
unsigned hg_remux_job_progress(const HGRemuxJob *job) { return job ? atomic_load(&job->progress) : 0; }
size_t hg_remux_job_error(HGRemuxJob *job, char *buffer, size_t capacity) {
    if (!job) return 0;
    pthread_mutex_lock(&job->error_lock);
    size_t length = strlen(job->error);
    if (buffer && capacity) snprintf(buffer, capacity, "%s", job->error);
    pthread_mutex_unlock(&job->error_lock);
    return length;
}
const char *hg_remux_version(void) { return "HGRemux 1 / " LIBAVFORMAT_IDENT; }

// Saved HG playlists use sibling numbered .ts/.mp4 files. Reject URL syntax,
// traversal and symlinks; custom io_open also checks every FFmpeg file access.
static bool asset_name(const char *name) {
    size_t length = strlen(name);
    if (!length || length > 128 || name[0] == '.') return false;
    for (const unsigned char *c = (const unsigned char *)name; *c; ++c)
        if (!( (*c >= 'a' && *c <= 'z') || (*c >= 'A' && *c <= 'Z') ||
               (*c >= '0' && *c <= '9') || *c == '.' || *c == '_' || *c == '-')) return false;
    const char *ext = strrchr(name, '.');
    return ext && (!strcmp(ext, ".ts") || !strcmp(ext, ".mp4") || !strcmp(ext, ".m4s"));
}
static int checked_open(AVFormatContext *context, AVIOContext **io, const char *url,
                        int flags, AVDictionary **options) {
    Pipeline *p = context->opaque;
    if (!p || flags != AVIO_FLAG_READ || cancelled(p->job)) return AVERROR_EXIT;
    const char *filename = !strncmp(url, "file:", 5) ? url + 5 : url;
    if (filename[0] != '/') return AVERROR(EACCES);
    const char *name = strrchr(filename, '/');
    if (!name || (strcmp(name + 1, "index.m3u8") && !asset_name(name + 1))) return AVERROR(EACCES);
    char resolved[PATH_MAX];
    if (!realpath(filename, resolved)) return AVERROR(errno);
    size_t length = strlen(p->directory);
    if (strncmp(resolved, p->directory, length) || resolved[length] != '/' ||
        strchr(resolved + length + 1, '/')) return AVERROR(EACCES);
    struct stat st;
    if (stat(resolved, &st) || !S_ISREG(st.st_mode)) return AVERROR(EACCES);
    return avio_open2(io, resolved, flags, &context->interrupt_callback, options);
}
static uint64_t read_big_endian(const unsigned char *bytes, unsigned count) {
    uint64_t value = 0;
    for (unsigned i = 0; i < count; ++i) value = (value << 8) | bytes[i];
    return value;
}
// Our fragmented output always ends in mfra. Requiring exact top-level box
// boundaries rejects a crash-truncated mdat even if MOV demux returns EOF.
static bool scan_mp4_boxes(HGRemuxJob *job, int fd, bool published) {
    struct stat st;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size < 8) return false;
    uint64_t offset = 0, length = (uint64_t)st.st_size;
    bool ftyp = false, moov = false, moof = false, mdat = false, mfra = false;
    while (offset < length) {
        if (cancelled(job)) return false;
        unsigned char header[16];
        if (length - offset < 8 || pread(fd, header, 8, (off_t)offset) != 8) return false;
        uint64_t size = read_big_endian(header, 4), minimum = 8;
        if (size == 1) {
            if (length - offset < 16 || pread(fd, header + 8, 8, (off_t)offset + 8) != 8) return false;
            size = read_big_endian(header + 8, 8); minimum = 16;
        }
        if (size < minimum || size > length - offset) return false;
        if (published && !offset && memcmp(header + 4, "ftyp", 4)) return false;
        if (!memcmp(header + 4, "ftyp", 4)) ftyp = true;
        if (!memcmp(header + 4, "moov", 4)) moov = true;
        if (!memcmp(header + 4, "moof", 4)) moof = true;
        if (!memcmp(header + 4, "mdat", 4)) mdat = true;
        if (!memcmp(header + 4, "mfra", 4)) mfra = offset + size == length;
        offset += size;
    }
    return offset == length && (!published || (ftyp && moov && moof && mdat && mfra));
}
static HGRemuxResult validate_manifest(Pipeline *p, const char *path, char canonical[PATH_MAX]) {
    if (path[0] != '/' || !realpath(path, canonical)) return fail(p, HG_REMUX_IO, "input", AVERROR(errno));
    snprintf(p->directory, sizeof(p->directory), "%s", canonical);
    char *slash = strrchr(p->directory, '/');
    if (!slash || strcmp(slash + 1, "index.m3u8")) return fail(p, HG_REMUX_INVALID, "expected local index.m3u8", 0);
    *slash = 0;
    FILE *file = fopen(canonical, "rb");
    if (!file) return fail(p, HG_REMUX_IO, "manifest", AVERROR(errno));
    struct stat st;
    if (fstat(fileno(file), &st) || !S_ISREG(st.st_mode) || st.st_size > HG_MAX_MANIFEST_BYTES) {
        fclose(file); return fail(p, HG_REMUX_UNSUPPORTED, "manifest size", 0);
    }
    char line[2048];
    bool header = false, ended = false;
    unsigned segments = 0, maps = 0;
    HGRemuxResult result = HG_REMUX_OK;
    while (fgets(line, sizeof(line), file)) {
        if (cancelled(p->job)) { result = HG_REMUX_CANCELLED; break; }
        size_t len = strlen(line);
        if (!len || (line[len - 1] != '\n' && !feof(file))) { result = HG_REMUX_UNSUPPORTED; break; }
        while (len && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = 0;
        if (!header) {
            if (strcmp(line, "#EXTM3U")) { result = HG_REMUX_INVALID; break; }
            header = true; continue;
        }
        if (!len) continue;
        if (!strcmp(line, "#EXT-X-ENDLIST")) { ended = true; continue; }
        if (!strncmp(line, "#EXT-X-DISCONTINUITY", 20) || !strncmp(line, "#EXT-X-KEY:", 11) ||
            !strncmp(line, "#EXT-X-BYTERANGE:", 17) || !strncmp(line, "#EXT-X-STREAM-INF:", 18) ||
            !strncmp(line, "#EXT-X-MEDIA:", 13) || !strncmp(line, "#EXT-X-GAP", 10)) {
            result = HG_REMUX_UNSUPPORTED; break;
        }
        const char *asset = NULL;
        if (!strncmp(line, "#EXTINF:", 8)) {
            char *end;
            double seconds = strtod(line + 8, &end);
            if (!isfinite(seconds) || seconds <= 0 || (*end && *end != ',')) { result = HG_REMUX_INVALID; break; }
            p->duration += seconds;
            if (p->duration > HG_MAX_SECONDS) { result = HG_REMUX_UNSUPPORTED; break; }
        } else if (!strncmp(line, "#EXT-X-MAP:", 11)) {
            const char *prefix = "#EXT-X-MAP:URI=\"";
            if (strncmp(line, prefix, strlen(prefix)) || ++maps > 1 || line[len - 1] != '"') {
                result = HG_REMUX_UNSUPPORTED; break;
            }
            line[len - 1] = 0;
            asset = line + strlen(prefix);
        } else if (line[0] != '#') {
            if (ended) { result = HG_REMUX_INVALID; break; }
            asset = line;
            if (++segments > 200000) { result = HG_REMUX_UNSUPPORTED; break; }
        }
        if (asset) {
            char child[PATH_MAX], resolved[PATH_MAX];
            if (!asset_name(asset) || snprintf(child, sizeof(child), "%s/%s", p->directory, asset) >= (int)sizeof(child) ||
                !realpath(child, resolved) || strcmp(child, resolved) || stat(child, &st) || !S_ISREG(st.st_mode) ||
                st.st_size <= 0 || st.st_size > HG_PACKET_BYTES) {
                result = HG_REMUX_INVALID; break;
            }
            // HG emits ordinary 188-byte MPEG-TS packets. Refuse a truncated
            // segment before FFmpeg can silently treat the short tail as EOF.
            const char *ext = strrchr(asset, '.');
            if (!strcmp(ext, ".ts") && st.st_size % 188) { result = HG_REMUX_INVALID; break; }
            if (strcmp(ext, ".ts")) {
                int fd = open(child, O_RDONLY | O_NOFOLLOW);
                bool complete = fd >= 0 && scan_mp4_boxes(p->job, fd, false);
                if (fd >= 0) close(fd);
                if (!complete) { result = HG_REMUX_INVALID; break; }
            }
        }
    }
    if (ferror(file)) result = HG_REMUX_IO;
    fclose(file);
    if (result == HG_REMUX_OK && (!header || !ended || !segments || p->duration <= 0)) result = HG_REMUX_INVALID;
    return result == HG_REMUX_OK ? result : fail(p, result, "unsupported or incomplete local playlist", 0);
}
static int write_output(void *opaque, const uint8_t *data, int size) {
    Pipeline *p = opaque;
    if (cancelled(p->job)) return AVERROR_EXIT;
    int written = 0;
    while (written < size) {
        ssize_t count = write(p->fd, data + written, (size_t)(size - written));
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return AVERROR(count < 0 ? errno : EIO);
        written += (int)count;
    }
    return written;
}
static int64_t seek_output(void *opaque, int64_t offset, int whence) {
    Pipeline *p = opaque;
    if (cancelled(p->job)) return AVERROR_EXIT;
    if (whence == AVSEEK_SIZE) {
        struct stat st;
        return fstat(p->fd, &st) ? AVERROR(errno) : st.st_size;
    }
    off_t result = lseek(p->fd, offset, whence & ~AVSEEK_FORCE);
    return result < 0 ? AVERROR(errno) : result;
}
static bool checked_add(int64_t a, int64_t b, int64_t *result) {
    if ((b > 0 && a > INT64_MAX - b) || (b < 0 && a < INT64_MIN - b)) return false;
    *result = a + b;
    return true;
}
static bool checked_subtract(int64_t a, int64_t b, int64_t *result) {
    if ((b > 0 && a < INT64_MIN + b) || (b < 0 && a > INT64_MAX + b)) return false;
    *result = a - b;
    return true;
}
static HGRemuxResult prepare_tracks(Pipeline *p) {
    if (!p->input->nb_streams || p->input->nb_streams > HG_MAX_STREAMS) return fail(p, HG_REMUX_UNSUPPORTED, "stream count", 0);
    p->stream_count = p->input->nb_streams;
    unsigned video = 0, audio = 0;
    for (unsigned i = 0; i < p->stream_count; ++i) {
        AVStream *in = p->input->streams[i];
        enum AVMediaType type = in->codecpar->codec_type;
        if (type != AVMEDIA_TYPE_VIDEO && type != AVMEDIA_TYPE_AUDIO) continue;
        enum AVCodecID codec = in->codecpar->codec_id;
        if ((type == AVMEDIA_TYPE_VIDEO && (++video > 1 || (codec != AV_CODEC_ID_H264 && codec != AV_CODEC_ID_HEVC))) ||
            (type == AVMEDIA_TYPE_AUDIO && (++audio > 1 || codec != AV_CODEC_ID_AAC))) return fail(p, HG_REMUX_UNSUPPORTED, "codec or multiple tracks", 0);
        Track *t = &p->tracks[i];
        if (in->time_base.num <= 0 || in->time_base.den <= 0) return fail(p, HG_REMUX_UNSUPPORTED, "track time base", 0);
        t->input = in;
        t->last_dts = AV_NOPTS_VALUE;
        t->audio_anchor = AV_NOPTS_VALUE;
        t->output = avformat_new_stream(p->output, NULL);
        if (!t->output) return fail(p, HG_REMUX_INTERNAL, "allocate stream", AVERROR(ENOMEM));
        int ret = avcodec_parameters_copy(t->output->codecpar, in->codecpar);
        if (ret < 0) return fail(p, HG_REMUX_INTERNAL, "copy codec", ret);
        t->output->codecpar->codec_tag = 0;
        t->output->time_base = in->time_base;
        t->output->disposition = in->disposition;
        if (type == AVMEDIA_TYPE_VIDEO) {
            t->parser = av_parser_init(codec);
            t->parser_codec = avcodec_alloc_context3(NULL);
            if (!t->parser || !t->parser_codec) return fail(p, HG_REMUX_INTERNAL, "video parser", AVERROR(ENOMEM));
            t->parser->flags |= PARSER_FLAG_COMPLETE_FRAMES;
            if ((ret = avcodec_parameters_to_context(t->parser_codec, in->codecpar)) < 0)
                return fail(p, HG_REMUX_INTERNAL, "video parser configuration", ret);
        }
        const char *filter_name = codec == AV_CODEC_ID_AAC ? "aac_adtstoasc" :
            (in->codecpar->extradata_size > 0 && in->codecpar->extradata[0] == 1 ? "null" : "extract_extradata");
        const AVBitStreamFilter *filter = av_bsf_get_by_name(filter_name);
        if (!filter || (ret = av_bsf_alloc(filter, &t->filter)) < 0) return fail(p, HG_REMUX_INTERNAL, "allocate bitstream filter", filter ? ret : AVERROR_BSF_NOT_FOUND);
        if ((ret = avcodec_parameters_copy(t->filter->par_in, in->codecpar)) < 0) return fail(p, HG_REMUX_INTERNAL, "filter codec", ret);
        t->filter->time_base_in = in->time_base;
        if ((ret = av_bsf_init(t->filter)) < 0) return fail(p, HG_REMUX_UNSUPPORTED, "initialize bitstream filter", ret);
    }
    return video ? HG_REMUX_OK : fail(p, HG_REMUX_UNSUPPORTED, "video track missing", 0);
}
// avformat_find_stream_info does not fill decoded dimensions/sample layout
// when decoders are deliberately absent. The public parser reads headers only.
static HGRemuxResult parse_packet_headers(Pipeline *p, Track *t, AVPacket *packet) {
    AVCodecParameters *par = t->output->codecpar;
    if (t->parser) {
        uint8_t *parsed = NULL;
        int parsed_size = 0;
        int ret = av_parser_parse2(t->parser, t->parser_codec, &parsed, &parsed_size,
                                  packet->data, packet->size, packet->pts, packet->dts, packet->pos);
        if (ret < 0) return fail(p, HG_REMUX_UNSUPPORTED, "parse video header", ret);
        if (t->parser->width > 0 && t->parser->height > 0) {
            par->width = t->parser->width; par->height = t->parser->height;
            par->format = t->parser->format;
            par->profile = t->parser_codec->profile; par->level = t->parser_codec->level;
            par->sample_aspect_ratio = t->parser_codec->sample_aspect_ratio;
            t->output->avg_frame_rate = t->parser_codec->framerate;
        }
    } else if (par->codec_id == AV_CODEC_ID_AAC) {
        if (packet->size >= 7 && packet->data[0] == 0xff && (packet->data[1] & 0xf6) == 0xf0) {
            static const int rates[] = {96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350};
            static const int channels[] = {0,1,2,3,4,5,6,8};
            if (packet->data[6] & 3) return fail(p, HG_REMUX_UNSUPPORTED, "AAC multiple raw blocks", 0);
            unsigned frequency = (packet->data[2] >> 2) & 15;
            unsigned layout = ((packet->data[2] & 1) << 2) | (packet->data[3] >> 6);
            if (frequency >= sizeof(rates) / sizeof(rates[0]) || !channels[layout])
                return fail(p, HG_REMUX_UNSUPPORTED, "AAC ADTS configuration", 0);
            int profile = packet->data[2] >> 6;
            if (t->ready && (par->sample_rate != rates[frequency] ||
                par->ch_layout.nb_channels != channels[layout] || par->profile != profile))
                return fail(p, HG_REMUX_UNSUPPORTED, "AAC configuration changes", 0);
            par->sample_rate = rates[frequency];
            par->profile = profile;
            av_channel_layout_uninit(&par->ch_layout);
            av_channel_layout_default(&par->ch_layout, channels[layout]);
            par->frame_size = 1024;
            // ADTS/PES timestamps are sparse. With decoders disabled, demux
            // cannot extrapolate between PES headers. Count exact AAC samples
            // from each known timestamp instead of inventing a network clock.
            int64_t known = packet->dts != AV_NOPTS_VALUE ? packet->dts : packet->pts;
            if (known != AV_NOPTS_VALUE) { t->audio_anchor = known; t->audio_samples = 0; }
            if (t->audio_anchor == AV_NOPTS_VALUE) return fail(p, HG_REMUX_UNSUPPORTED, "AAC initial timestamp missing", 0);
            int64_t offset = av_rescale_q(t->audio_samples, (AVRational){1, par->sample_rate}, t->input->time_base);
            if (offset < 0 || (packet->dts == AV_NOPTS_VALUE && !checked_add(t->audio_anchor, offset, &packet->dts)))
                return fail(p, HG_REMUX_UNSUPPORTED, "AAC timestamp overflow", 0);
            if (packet->pts == AV_NOPTS_VALUE) packet->pts = packet->dts;
            t->audio_samples += 1024;
            offset = av_rescale_q(t->audio_samples, (AVRational){1, par->sample_rate}, t->input->time_base);
            int64_t next;
            if (offset < 0 || !checked_add(t->audio_anchor, offset, &next) ||
                !checked_subtract(next, packet->dts, &packet->duration))
                return fail(p, HG_REMUX_UNSUPPORTED, "AAC duration overflow", 0);
        }
        if (par->sample_rate <= 0 || par->ch_layout.nb_channels <= 0)
            return fail(p, HG_REMUX_UNSUPPORTED, "AAC layout missing", 0);
        if (packet->duration <= 0) packet->duration = av_rescale_q(1024, (AVRational){1, par->sample_rate}, t->input->time_base);
    }
    return HG_REMUX_OK;
}
static size_t annexb_start(const uint8_t *data, size_t size, size_t from, size_t *payload) {
    for (size_t i = from; i + 2 < size; ++i) {
        if (data[i] || data[i + 1]) continue;
        size_t j = i + 2;
        while (j < size && !data[j]) ++j;
        if (j < size && data[j] == 1) { *payload = j + 1; return i; }
    }
    return size;
}
// Annex-B permits 3/4-byte start codes and trailing_zero_8bits. Canonicalize
// those framing bytes, so repeated SPS/PPS is not mistaken for a codec change.
static uint8_t *canonical_config(enum AVCodecID codec, const uint8_t *data, size_t size, size_t *length) {
    *length = size;
    if (codec == AV_CODEC_ID_AAC || data[0] == 1) return av_memdup(data, size);
    size_t payload = 0, start = annexb_start(data, size, 0, &payload);
    if (start == size) return av_memdup(data, size);
    uint8_t *result = av_malloc(size * 2 + 16);
    if (!result) return NULL;
    size_t used = 0;
    while (start < size) {
        size_t next_payload = 0;
        size_t next = annexb_start(data, size, payload, &next_payload);
        size_t end = next;
        while (end > payload && !data[end - 1]) --end;
        size_t nal = end - payload;
        if (nal) {
            result[used++] = (uint8_t)(nal >> 24); result[used++] = (uint8_t)(nal >> 16);
            result[used++] = (uint8_t)(nal >> 8); result[used++] = (uint8_t)nal;
            memcpy(result + used, data + payload, nal); used += nal;
        }
        start = next; payload = next_payload;
    }
    *length = used;
    return result;
}
static HGRemuxResult packet_config(Pipeline *p, Track *t, AVPacket *packet) {
    size_t size = 0;
    const uint8_t *config = av_packet_get_side_data(packet, AV_PKT_DATA_NEW_EXTRADATA, &size);
    if (size > 1024 * 1024) return fail(p, HG_REMUX_UNSUPPORTED, "codec configuration budget", 0);
    if (!t->ready) {
        if (!size) { config = t->input->codecpar->extradata; size = (size_t)t->input->codecpar->extradata_size; }
        if (!size || size > 1024 * 1024) return fail(p, HG_REMUX_UNSUPPORTED, "codec configuration missing", 0);
        t->config = canonical_config(t->input->codecpar->codec_id, config, size, &t->config_size);
        if (!t->config) return fail(p, HG_REMUX_INTERNAL, "codec configuration", AVERROR(ENOMEM));
        av_freep(&t->output->codecpar->extradata);
        t->output->codecpar->extradata = av_mallocz(size + AV_INPUT_BUFFER_PADDING_SIZE);
        if (!t->output->codecpar->extradata) return fail(p, HG_REMUX_INTERNAL, "output codec configuration", AVERROR(ENOMEM));
        memcpy(t->output->codecpar->extradata, config, size);
        t->output->codecpar->extradata_size = (int)size;
        t->ready = true;
    } else if (size) {
        size_t canonical_size = 0;
        uint8_t *canonical = canonical_config(t->input->codecpar->codec_id, config, size, &canonical_size);
        if (!canonical) return fail(p, HG_REMUX_INTERNAL, "compare codec configuration", AVERROR(ENOMEM));
        bool changed = canonical_size != t->config_size || memcmp(canonical, t->config, canonical_size);
        av_free(canonical);
        if (changed) return fail(p, HG_REMUX_UNSUPPORTED, "codec configuration changes", 0);
    }
    return HG_REMUX_OK;
}
static bool tracks_ready(Pipeline *p) {
    for (unsigned i = 0; i < p->stream_count; ++i)
        if (p->tracks[i].input && !p->tracks[i].ready) return false;
    return true;
}
static HGRemuxResult write_packet(Pipeline *p, AVPacket *packet) {
    Track *t = &p->tracks[packet->stream_index];
    if (packet->dts == AV_NOPTS_VALUE || packet->pts == AV_NOPTS_VALUE ||
        (packet->flags & AV_PKT_FLAG_CORRUPT)) return fail(p, HG_REMUX_UNSUPPORTED, "packet timing or damaged payload", 0);
    int64_t current_us = av_rescale_q(packet->dts, t->input->time_base, AV_TIME_BASE_Q);
    int64_t relative_us, end_pts, end_us;
    if (packet->duration < 0 || current_us == AV_NOPTS_VALUE ||
        !checked_subtract(current_us, p->origin_us, &relative_us) ||
        !checked_add(packet->pts, packet->duration, &end_pts))
        return fail(p, HG_REMUX_UNSUPPORTED, "timestamp overflow", 0);
    int64_t absolute_end = av_rescale_q(end_pts, t->input->time_base, AV_TIME_BASE_Q);
    if (absolute_end == AV_NOPTS_VALUE || !checked_subtract(absolute_end, p->origin_us, &end_us))
        return fail(p, HG_REMUX_UNSUPPORTED, "end timestamp overflow", 0);
    double seconds = relative_us / (double)AV_TIME_BASE;
    if (!isfinite(seconds) || seconds < -1.0 || seconds > HG_MAX_SECONDS || end_us < -AV_TIME_BASE || end_us > HG_MAX_SECONDS * (int64_t)AV_TIME_BASE)
        return fail(p, HG_REMUX_UNSUPPORTED, "timestamp range", 0);
    if (end_us > p->end_us) p->end_us = end_us;
    unsigned progress = (unsigned)(fmax(0.0, fmin(seconds / p->duration, 0.99)) * 10000);
    unsigned previous = atomic_load(&p->job->progress);
    if (progress > previous) atomic_store(&p->job->progress, progress);
    int64_t origin = av_rescale_q(p->origin_us, AV_TIME_BASE_Q, t->input->time_base);
    if (origin == AV_NOPTS_VALUE || !checked_subtract(packet->pts, origin, &packet->pts) ||
        !checked_subtract(packet->dts, origin, &packet->dts))
        return fail(p, HG_REMUX_UNSUPPORTED, "track origin overflow", 0);
    av_packet_rescale_ts(packet, t->input->time_base, t->output->time_base);
    if (t->last_dts != AV_NOPTS_VALUE && packet->dts <= t->last_dts) return fail(p, HG_REMUX_UNSUPPORTED, "nonmonotonic timestamps", 0);
    t->last_dts = packet->dts;
    packet->stream_index = t->output->index;
    packet->pos = -1;
    p->interleave_bytes += (size_t)packet->size;
    int ret = av_interleaved_write_frame(p->output, packet);
    if (ret >= 0 && p->interleave_bytes >= HG_INTERLEAVE_BYTES) {
        // Time limits alone cannot bound densely timestamped/high-bitrate
        // packets awaiting another track. The API permits flushing this queue.
        ret = av_interleaved_write_frame(p->output, NULL);
        p->interleave_bytes = 0;
    }
    if (ret >= 0) ++t->written_packets;
    return ret < 0 ? fail(p, HG_REMUX_IO, "write MP4 packet", ret) : HG_REMUX_OK;
}
static HGRemuxResult receive_packets(Pipeline *p, Track *t, bool buffering) {
    AVPacket *packet = av_packet_alloc();
    if (!packet) return fail(p, HG_REMUX_INTERNAL, "packet allocation", AVERROR(ENOMEM));
    HGRemuxResult result = HG_REMUX_OK;
    int ret;
    while ((ret = av_bsf_receive_packet(t->filter, packet)) >= 0) {
        // Filters are per-track and may not preserve the demux stream index.
        packet->stream_index = (int)(t - p->tracks);
        if (packet->size <= 0 || packet->size > HG_PACKET_BYTES || ++p->packet_count > HG_MAX_PACKETS) {
            result = fail(p, HG_REMUX_UNSUPPORTED, "packet budget", 0); break;
        }
        if ((result = packet_config(p, t, packet)) != HG_REMUX_OK) break;
        if (buffering) {
            if (p->buffered_bytes + (size_t)packet->size > HG_PREFETCH_BYTES) { result = fail(p, HG_REMUX_UNSUPPORTED, "initial track interleave budget", 0); break; }
            Buffered *node = calloc(1, sizeof(*node));
            if (!node || !(node->packet = av_packet_clone(packet))) { free(node); result = fail(p, HG_REMUX_INTERNAL, "prefetch allocation", AVERROR(ENOMEM)); break; }
            if (p->last) p->last->next = node; else p->first = node;
            p->last = node;
            p->buffered_bytes += (size_t)packet->size;
        } else result = write_packet(p, packet);
        av_packet_unref(packet);
        if (result != HG_REMUX_OK || cancelled(p->job)) break;
    }
    av_packet_free(&packet);
    if (result != HG_REMUX_OK) return result;
    return (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) ? HG_REMUX_OK : fail(p, HG_REMUX_UNSUPPORTED, "filter packet", ret);
}
static HGRemuxResult convert(Pipeline *p, const char *canonical) {
    p->input = avformat_alloc_context();
    if (!p->input) return fail(p, HG_REMUX_INTERNAL, "input context", AVERROR(ENOMEM));
    p->input->opaque = p;
    p->input->io_open = checked_open;
    p->input->interrupt_callback = (AVIOInterruptCB){interrupted, p->job};
    p->input->probesize = HG_PREFETCH_BYTES;
    p->input->max_analyze_duration = 10 * AV_TIME_BASE;
    p->input->max_probe_packets = 2048;
    AVDictionary *options = NULL;
    av_dict_set(&options, "protocol_whitelist", "file", 0);
    av_dict_set(&options, "allowed_extensions", "m3u8,ts,mp4,m4s", 0);
    av_dict_set(&options, "allowed_segment_extensions", "ts,mp4,m4s", 0);
    av_dict_set(&options, "max_reload", "1", 0);
    int ret = avformat_open_input(&p->input, canonical, av_find_input_format("hls"), &options);
    av_dict_free(&options);
    if (ret < 0) return fail(p, HG_REMUX_INVALID, "open local HLS", ret);
    if ((ret = avformat_find_stream_info(p->input, NULL)) < 0) return fail(p, HG_REMUX_UNSUPPORTED, "probe tracks", ret);
    if ((ret = avformat_alloc_output_context2(&p->output, NULL, "mp4", NULL)) < 0) return fail(p, HG_REMUX_INTERNAL, "MP4 context", ret);
    p->output->interrupt_callback = (AVIOInterruptCB){interrupted, p->job};
    p->output->flags |= AVFMT_FLAG_CUSTOM_IO;
    p->output->max_interleave_delta = AV_TIME_BASE;
    HGRemuxResult result = prepare_tracks(p);
    if (result != HG_REMUX_OK) return result;
    AVPacket *packet = av_packet_alloc();
    if (!packet) return fail(p, HG_REMUX_INTERNAL, "read packet allocation", AVERROR(ENOMEM));
    // Header must already contain AVC/HEVC configuration and AAC ASC. Keep only
    // bounded initial packets while the first packet of each track supplies it.
    while (!tracks_ready(p) && !cancelled(p->job) && (ret = av_read_frame(p->input, packet)) >= 0) {
        if ((unsigned)packet->stream_index >= p->stream_count) { result = HG_REMUX_UNSUPPORTED; break; }
        Track *t = &p->tracks[packet->stream_index];
        if (t->input) {
            result = parse_packet_headers(p, t, packet);
            if (result != HG_REMUX_OK) break;
            ret = av_bsf_send_packet(t->filter, packet);
            if (ret < 0) { result = fail(p, HG_REMUX_UNSUPPORTED, "prefetch filter", ret); break; }
            result = receive_packets(p, t, true);
        }
        av_packet_unref(packet);
        if (result != HG_REMUX_OK) break;
    }
    if (result != HG_REMUX_OK || !tracks_ready(p) || !p->first || cancelled(p->job)) {
        av_packet_free(&packet); return result != HG_REMUX_OK ? result : fail(p, HG_REMUX_UNSUPPORTED, "initial tracks incomplete", ret);
    }
    p->origin_us = INT64_MAX;
    for (Buffered *node = p->first; node; node = node->next) {
        AVPacket *pkt = node->packet;
        if (pkt->dts == AV_NOPTS_VALUE) { av_packet_free(&packet); return fail(p, HG_REMUX_UNSUPPORTED, "initial DTS missing", 0); }
        int64_t timestamp = av_rescale_q(pkt->dts, p->tracks[pkt->stream_index].input->time_base, AV_TIME_BASE_Q);
        if (timestamp < p->origin_us) p->origin_us = timestamp;
    }
    uint8_t *buffer = av_malloc(32 * 1024);
    if (!buffer || !(p->output_io = avio_alloc_context(buffer, 32 * 1024, 1, p, NULL, write_output, seek_output))) {
        av_free(buffer); av_packet_free(&packet); return fail(p, HG_REMUX_INTERNAL, "output IO", AVERROR(ENOMEM));
    }
    p->output->pb = p->output_io;
    av_dict_set(&options, "movflags", "frag_keyframe+delay_moov+default_base_moof", 0);
    av_dict_set(&options, "frag_duration", "2000000", 0);
    av_dict_set(&options, "frag_size", "4194304", 0);
    av_dict_set(&options, "use_editlist", "1", 0);
    av_dict_set(&options, "movie_timescale", "1000000", 0);
    ret = avformat_write_header(p->output, &options);
    av_dict_free(&options);
    if (ret < 0) { av_packet_free(&packet); return fail(p, HG_REMUX_UNSUPPORTED, "MP4 header", ret); }
    while (p->first && result == HG_REMUX_OK && !cancelled(p->job)) {
        Buffered *node = p->first;
        p->first = node->next;
        result = write_packet(p, node->packet);
        av_packet_free(&node->packet);
        free(node);
    }
    p->last = NULL;
    while (result == HG_REMUX_OK && !cancelled(p->job) && (ret = av_read_frame(p->input, packet)) >= 0) {
        if ((unsigned)packet->stream_index >= p->stream_count) { result = fail(p, HG_REMUX_UNSUPPORTED, "new stream", 0); break; }
        Track *t = &p->tracks[packet->stream_index];
        if (t->input) {
            result = parse_packet_headers(p, t, packet);
            if (result != HG_REMUX_OK) break;
            ret = av_bsf_send_packet(t->filter, packet);
            if (ret < 0) { result = fail(p, HG_REMUX_UNSUPPORTED, "filter input", ret); break; }
            result = receive_packets(p, t, false);
        }
        av_packet_unref(packet);
    }
    av_packet_free(&packet);
    if (result != HG_REMUX_OK) return result;
    if (cancelled(p->job)) return HG_REMUX_CANCELLED;
    if (ret != AVERROR_EOF) return fail(p, HG_REMUX_INVALID, "read HLS packet", ret);
    for (unsigned i = 0; i < p->stream_count; ++i) {
        Track *t = &p->tracks[i];
        if (!t->filter) continue;
        ret = av_bsf_send_packet(t->filter, NULL);
        if (ret < 0) return fail(p, HG_REMUX_UNSUPPORTED, "flush filter", ret);
        result = receive_packets(p, t, false);
        if (result != HG_REMUX_OK) return result;
    }
    for (unsigned i = 0; i < p->stream_count; ++i)
        if (p->tracks[i].input && !p->tracks[i].written_packets)
            return fail(p, HG_REMUX_INVALID, "empty output track", 0);
    if (p->end_us / (double)AV_TIME_BASE + 0.25 < p->duration)
        return fail(p, HG_REMUX_INVALID, "media shorter than complete playlist", 0);
    ret = av_write_trailer(p->output);
    if (ret < 0) return fail(p, HG_REMUX_IO, "finish MP4", ret);
    avio_flush(p->output_io);
    if (p->output_io->error < 0) return fail(p, HG_REMUX_IO, "flush MP4", p->output_io->error);
    if (fsync(p->fd)) return fail(p, HG_REMUX_IO, "sync MP4", AVERROR(errno));
    return HG_REMUX_OK;
}
HGRemuxResult hg_remux_run(HGRemuxJob *job, const char *input, const char *output) {
    if (!job || !input || !output || !*input || !*output) return HG_REMUX_INVALID;
    if (atomic_exchange(&job->running, true)) return HG_REMUX_BUSY;
    Pipeline p = {.job = job, .fd = -1};
    pthread_mutex_lock(&job->error_lock); job->error[0] = 0; pthread_mutex_unlock(&job->error_lock);
    atomic_store(&job->progress, 0);
    char canonical[PATH_MAX];
    HGRemuxResult result;
    if (cancelled(job)) result = HG_REMUX_CANCELLED;
    else if (output[0] != '/' || strlen(output) + 20 >= PATH_MAX) result = fail(&p, HG_REMUX_INVALID, "output path", 0);
    else {
        result = validate_manifest(&p, input, canonical);
        if (result == HG_REMUX_OK) {
            struct stat st;
            if (!lstat(output, &st) || errno != ENOENT) result = fail(&p, HG_REMUX_EXISTS, "output already exists or inaccessible", 0);
            else {
                snprintf(p.temporary, sizeof(p.temporary), "%s.hgremux-XXXXXX", output);
                p.fd = mkstemp(p.temporary);
                if (p.fd < 0) { p.temporary[0] = 0; result = fail(&p, HG_REMUX_IO, "create private output", AVERROR(errno)); }
                else result = convert(&p, canonical);
            }
        }
    }
    if (p.input) avformat_close_input(&p.input);
    if (p.output) { p.output->pb = NULL; avformat_free_context(p.output); }
    if (p.output_io) { av_freep(&p.output_io->buffer); avio_context_free(&p.output_io); }
    if (p.fd >= 0) close(p.fd);
    for (unsigned i = 0; i < HG_MAX_STREAMS; ++i) {
        av_bsf_free(&p.tracks[i].filter); av_free(p.tracks[i].config);
        av_parser_close(p.tracks[i].parser); avcodec_free_context(&p.tracks[i].parser_codec);
    }
    while (p.first) { Buffered *next = p.first->next; av_packet_free(&p.first->packet); free(p.first); p.first = next; }
    if (result == HG_REMUX_OK) {
        if (cancelled(job)) result = HG_REMUX_CANCELLED;
        else if (link(p.temporary, output)) result = fail(&p, errno == EEXIST ? HG_REMUX_EXISTS : HG_REMUX_IO, "publish MP4", AVERROR(errno));
        else atomic_store(&job->progress, 10000);
    }
    if (p.temporary[0]) unlink(p.temporary);
    atomic_store(&job->running, false);
    return result;
}


HGRemuxResult hg_remux_validate(HGRemuxJob *job, const char *path) {
    if (!job || !path || path[0] != '/') return HG_REMUX_INVALID;
    if (atomic_exchange(&job->running, true)) return HG_REMUX_BUSY;
    Pipeline p = {.job = job, .fd = -1};
    atomic_store(&job->progress, 0);
    pthread_mutex_lock(&job->error_lock); job->error[0] = 0; pthread_mutex_unlock(&job->error_lock);
    int fd = open(path, O_RDONLY | O_NOFOLLOW);
    HGRemuxResult result = HG_REMUX_OK;
    AVFormatContext *input = NULL;
    AVPacket *packet = NULL;
    AVDictionary *options = NULL;
    if (cancelled(job)) result = HG_REMUX_CANCELLED;
    else if (fd < 0) result = fail(&p, HG_REMUX_IO, "open published MP4", AVERROR(errno));
    else if (!scan_mp4_boxes(job, fd, true)) result = fail(&p, HG_REMUX_INVALID, "incomplete fragmented MP4", 0);
    if (fd >= 0) close(fd);
    if (result == HG_REMUX_OK) {
        input = avformat_alloc_context();
        if (!input) result = fail(&p, HG_REMUX_INTERNAL, "validate context", AVERROR(ENOMEM));
        else {
            input->interrupt_callback = (AVIOInterruptCB){interrupted, job};
            input->probesize = HG_PREFETCH_BYTES;
            input->max_analyze_duration = 10 * AV_TIME_BASE;
            input->max_probe_packets = 2048;
            av_dict_set(&options, "protocol_whitelist", "file", 0);
            int ret = avformat_open_input(&input, path, av_find_input_format("mov"), &options);
            if (ret < 0 || (ret = avformat_find_stream_info(input, NULL)) < 0)
                result = fail(&p, HG_REMUX_INVALID, "validate tracks", ret);
        }
    }
    if (result == HG_REMUX_OK) {
        bool video = false;
        if (!input->nb_streams || input->nb_streams > HG_MAX_STREAMS) result = HG_REMUX_INVALID;
        else for (unsigned i = 0; i < input->nb_streams; ++i) {
            AVCodecParameters *par = input->streams[i]->codecpar;
            if (par->codec_type == AVMEDIA_TYPE_VIDEO) video = true;
            if ((par->codec_type == AVMEDIA_TYPE_VIDEO && (par->width <= 0 || par->height <= 0)) ||
                (par->codec_type == AVMEDIA_TYPE_AUDIO && (par->sample_rate <= 0 || par->ch_layout.nb_channels <= 0)) ||
                par->extradata_size <= 0 ||
                (par->codec_id != AV_CODEC_ID_H264 && par->codec_id != AV_CODEC_ID_HEVC && par->codec_id != AV_CODEC_ID_AAC)) {
                result = fail(&p, HG_REMUX_INVALID, "validate codec configuration", 0); break;
            }
        }
        if (!video) result = fail(&p, HG_REMUX_INVALID, "validate video track", 0);
    }
    if (result == HG_REMUX_OK) {
        packet = av_packet_alloc();
        if (!packet) result = HG_REMUX_INTERNAL;
        else {
            int64_t last[HG_MAX_STREAMS];
            for (unsigned i = 0; i < HG_MAX_STREAMS; ++i) last[i] = AV_NOPTS_VALUE;
            uint64_t count = 0, per_stream[HG_MAX_STREAMS] = {0};
            int ret;
            while (!cancelled(job) && (ret = av_read_frame(input, packet)) >= 0) {
                unsigned index = (unsigned)packet->stream_index;
                if (index >= input->nb_streams || packet->size <= 0 || packet->size > HG_PACKET_BYTES ||
                    (packet->flags & AV_PKT_FLAG_CORRUPT) || packet->dts == AV_NOPTS_VALUE || packet->pts == AV_NOPTS_VALUE ||
                    (last[index] != AV_NOPTS_VALUE && packet->dts <= last[index]) || ++count > HG_MAX_PACKETS) {
                    result = fail(&p, HG_REMUX_INVALID, "validate packet timing", 0); break;
                }
                last[index] = packet->dts;
                ++per_stream[index];
                av_packet_unref(packet);
            }
            if (cancelled(job)) result = HG_REMUX_CANCELLED;
            else if (result == HG_REMUX_OK && (ret != AVERROR_EOF || !count)) result = fail(&p, HG_REMUX_INVALID, "validate packet body", ret);
            if (result == HG_REMUX_OK) for (unsigned i = 0; i < input->nb_streams; ++i)
                if (!per_stream[i]) { result = fail(&p, HG_REMUX_INVALID, "validate empty track", 0); break; }
        }
    }
    av_packet_free(&packet);
    av_dict_free(&options);
    avformat_close_input(&input);
    if (result == HG_REMUX_OK) atomic_store(&job->progress, 10000);
    atomic_store(&job->running, false);
    return result;
}
