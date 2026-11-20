// SPDX-License-Identifier: LGPL-2.1-or-later
// Host/simulator CLI for the same C source and ABI used by the application.
#include "HGRemux.h"
#include <stdio.h>
#include <string.h>
#include <pthread.h>
#include <time.h>
#include <sched.h>
#include <glob.h>
#include <sys/stat.h>
#include <limits.h>
#include <stdatomic.h>
typedef struct { HGRemuxJob *job; const char *output; atomic_ullong observed_bytes; } CancelContext;
static void *cancel_soon(void *opaque) {
    CancelContext *context = opaque;
    struct timespec begin, now;
    clock_gettime(CLOCK_MONOTONIC, &begin);
    char pattern[PATH_MAX];
    snprintf(pattern, sizeof(pattern), "%s.hgremux-*", context->output);
    do {
        if (hg_remux_job_progress(context->job) > 5000) {
            glob_t matches = {0};
            if (!glob(pattern, GLOB_NOSORT, NULL, &matches)) {
                for (size_t i = 0; i < matches.gl_pathc; ++i) {
                    struct stat st;
                    if (!stat(matches.gl_pathv[i], &st) && st.st_size > 0)
                        atomic_store(&context->observed_bytes, (unsigned long long)st.st_size);
                }
            }
            globfree(&matches);
            if (atomic_load(&context->observed_bytes)) break;
        }
        sched_yield();
        clock_gettime(CLOCK_MONOTONIC, &now);
    } while (now.tv_sec - begin.tv_sec < 5);
    hg_remux_job_cancel(context->job);
    return NULL;
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: smoke [--validate|--cancel] input [output]\n"); return 64; }
    HGRemuxJob *job = hg_remux_job_create();
    if (!job) return 70;
    HGRemuxResult result;
    CancelContext context = {.job = job, .output = argc == 4 ? argv[3] : ""};
    atomic_init(&context.observed_bytes, 0);
    if (!strcmp(argv[1], "--validate")) result = hg_remux_validate(job, argv[2]);
    else if (!strcmp(argv[1], "--cancel-after") && argc == 4) {
        pthread_t thread;
        if (pthread_create(&thread, NULL, cancel_soon, &context)) return 70;
        result = hg_remux_run(job, argv[2], argv[3]);
        pthread_join(thread, NULL);
    } else if (!strcmp(argv[1], "--cancel")) {
        hg_remux_job_cancel(job);
        result = argc == 4 ? hg_remux_run(job, argv[2], argv[3]) : HG_REMUX_INVALID;
    } else result = hg_remux_run(job, argv[1], argv[2]);
    char error[256];
    hg_remux_job_error(job, error, sizeof(error));
    printf("result=%d progress=%u cancel_bytes=%llu error=%s\n", result, hg_remux_job_progress(job), atomic_load(&context.observed_bytes), error);
    hg_remux_job_destroy(job);
    return result;
}
