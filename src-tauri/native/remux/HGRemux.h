#ifndef HG_REMUX_H
#define HG_REMUX_H
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif

// The engine never decodes, encodes, fetches URLs, or deletes source media.
typedef struct HGRemuxJob HGRemuxJob;
typedef enum {
    HG_REMUX_OK = 0,
    HG_REMUX_CANCELLED = 1,
    HG_REMUX_UNSUPPORTED = 2,
    HG_REMUX_IO = 3,
    HG_REMUX_INVALID = 4,
    HG_REMUX_INTERNAL = 5,
    HG_REMUX_EXISTS = 6,
    HG_REMUX_BUSY = 7
} HGRemuxResult;

HGRemuxJob *hg_remux_job_create(void);
// Safe while run() executes. Cancellation is sticky; create another job to retry.
void hg_remux_job_cancel(HGRemuxJob *job);
// Caller must join the run() thread before destroying the job.
void hg_remux_job_destroy(HGRemuxJob *job);
// Synchronous. Run on a bounded background worker. UTF-8 absolute local paths.
// final_mp4 must not exist; success publishes it atomically without replacement.
// A failure preserves every source and removes only this call's private temp file.
HGRemuxResult hg_remux_run(HGRemuxJob *job, const char *local_playlist, const char *final_mp4);
// Validate a previously published HGRemux fragmented MP4 without changing it.
// Used to recover a crash between output publication and app metadata commit.
HGRemuxResult hg_remux_validate(HGRemuxJob *job, const char *existing_mp4);
// Thread-safe snapshot in [0, 10000]. 10000 means the file has been published.
unsigned hg_remux_job_progress(const HGRemuxJob *job);
// Thread-safe NUL-terminated sanitized stage/error, never input/output paths.
size_t hg_remux_job_error(HGRemuxJob *job, char *buffer, size_t capacity);
const char *hg_remux_version(void);
#ifdef __cplusplus
}
#endif
#endif
