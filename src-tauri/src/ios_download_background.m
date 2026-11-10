#import <UIKit/UIKit.h>
#import <BackgroundTasks/BackgroundTasks.h>
#include <stdint.h>
#include <stdatomic.h>

enum {
    HGUnsupported, HGIdle, HGWaiting, HGRunning, HGUnavailable, HGExpired,
};

static _Atomic int status = HGUnsupported;

#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 260000
typedef struct {
    uint64_t completed;
    uint64_t interrupted;
    uint64_t failed;
    uint64_t remaining;
    uint64_t progress;
} HGDownloadSnapshot;

extern void hg_download_snapshot(HGDownloadSnapshot *snapshot);
extern void hg_download_expired(void);
extern void hg_download_foreground(void);

API_AVAILABLE(ios(26.0))
@interface HGDownloadLease : NSObject
@property(nonatomic, copy) NSString *identifier;
@property(nonatomic, strong) BGContinuedProcessingTask *task;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic) uint64_t completedAtStart;
@property(nonatomic) uint64_t interruptedAtStart;
@property(nonatomic) uint64_t failedAtStart;
@property(nonatomic) uint64_t previousRemaining;
@property(nonatomic) BOOL finished;
- (void)update;
- (void)finish:(int)state success:(BOOL)success;
@end

static HGDownloadLease *lease API_AVAILABLE(ios(26.0));

@implementation HGDownloadLease

- (void)finish:(int)state success:(BOOL)success {
    if (self.finished) return;
    self.finished = YES;
    [self.timer invalidate];
    self.timer = nil;
    if (self.task) {
        self.task.expirationHandler = nil;
        [self.task setTaskCompletedWithSuccess:success];
        self.task = nil;
    } else if (self.identifier) {
        [BGTaskScheduler.sharedScheduler cancelTaskRequestWithIdentifier:self.identifier];
    }
    if (lease == self) {
        lease = nil;
        atomic_store(&status, state);
    }
}

- (void)update {
    HGDownloadSnapshot snapshot = {0};
    hg_download_snapshot(&snapshot);
    uint64_t completed = snapshot.completed - self.completedAtStart;
    if (!snapshot.remaining) {
        BOOL success = snapshot.failed == self.failedAtStart;
        BOOL paused = snapshot.interrupted != self.interruptedAtStart;
        if (!success) {
            [self.task updateTitle:@"HGViewer 后台下载" subtitle:@"部分下载未完成，请回 App 查看"];
        } else if (paused) {
            [self.task updateTitle:@"HGViewer 后台下载" subtitle:@"下载已停止，可回 App 查看"];
        } else if (self.task) {
            self.task.progress.completedUnitCount = self.task.progress.totalUnitCount;
        }
        [self finish:HGIdle success:success];
        return;
    }
    if (!self.task) return;
    self.task.progress.totalUnitCount = (int64_t)((completed + snapshot.remaining) * 1000);
    self.task.progress.completedUnitCount = (int64_t)(completed * 1000 + snapshot.progress);
    if (self.previousRemaining != snapshot.remaining) {
        self.previousRemaining = snapshot.remaining;
        [self.task updateTitle:@"HGViewer 后台下载"
                      subtitle:[NSString stringWithFormat:@"%llu 项任务待完成", snapshot.remaining]];
    }
}

@end

static void hg_request_lease(void) API_AVAILABLE(ios(26.0));
static void hg_request_lease(void) {
    if (lease || UIApplication.sharedApplication.applicationState != UIApplicationStateActive) return;
    HGDownloadSnapshot snapshot = {0};
    hg_download_snapshot(&snapshot);
    if (!snapshot.remaining) return;

    HGDownloadLease *current = [HGDownloadLease new];
    current.identifier = [NSString stringWithFormat:@"%@.downloads.%@",
                          NSBundle.mainBundle.bundleIdentifier, NSUUID.UUID.UUIDString];
    current.completedAtStart = snapshot.completed;
    current.interruptedAtStart = snapshot.interrupted;
    current.failedAtStart = snapshot.failed;
    NSString *identifier = current.identifier;
    BGTaskScheduler *scheduler = BGTaskScheduler.sharedScheduler;
    BOOL registered = [scheduler registerForTaskWithIdentifier:identifier
                                                    usingQueue:dispatch_get_main_queue()
                                                 launchHandler:^(BGTask *task) {
        HGDownloadLease *running = lease;
        if (![task isKindOfClass:BGContinuedProcessingTask.class] ||
            ![running.identifier isEqualToString:identifier]) {
            [task setTaskCompletedWithSuccess:NO];
            return;
        }
        running.task = (BGContinuedProcessingTask *)task;
        __weak HGDownloadLease *weakRunning = running;
        task.expirationHandler = ^{
            dispatch_async(dispatch_get_main_queue(), ^{
                HGDownloadLease *expired = weakRunning;
                if (!expired || lease != expired) return;
                [expired update];
                if (expired.finished) return;
                BOOL foreground = UIApplication.sharedApplication.applicationState == UIApplicationStateActive;
                if (!foreground) hg_download_expired();
                [expired.task updateTitle:@"HGViewer 后台下载"
                                 subtitle:foreground ? @"下载在 App 内继续" : @"后台已中断，回 App 自动继续"];
                [expired finish:foreground ? HGIdle : HGExpired success:NO];
            });
        };
        atomic_store(&status, HGRunning);
        [running update];
    }];
    if (!registered) {
        atomic_store(&status, HGUnavailable);
        return;
    }

    lease = current;
    atomic_store(&status, HGWaiting);
    __weak HGDownloadLease *weakCurrent = current;
    current.timer = [NSTimer timerWithTimeInterval:1.0 repeats:YES block:^(__unused NSTimer *timer) {
        [weakCurrent update];
    }];
    [NSRunLoop.mainRunLoop addTimer:current.timer forMode:NSRunLoopCommonModes];

    BGContinuedProcessingTaskRequest *request = [[BGContinuedProcessingTaskRequest alloc]
        initWithIdentifier:identifier title:@"HGViewer 后台下载" subtitle:@"正在处理下载队列"];
    request.strategy = BGContinuedProcessingTaskRequestSubmissionStrategyQueue;
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 270000
    if (@available(iOS 27.0, *)) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            [scheduler submitTaskRequest:request completionHandler:^(NSError *error) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    HGDownloadLease *submitted = weakCurrent;
                    if (!submitted || lease != submitted) {
                        if (!error) [scheduler cancelTaskRequestWithIdentifier:identifier];
                        return;
                    }
                    if (error && !submitted.task) [submitted finish:HGUnavailable success:NO];
                });
            }];
        });
        return;
    }
#endif
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    if (![scheduler submitTaskRequest:request error:NULL]) [current finish:HGUnavailable success:NO];
#pragma clang diagnostic pop
}
#endif

void hg_observe_download_foreground(void) {
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 260000
    if (@available(iOS 26.0, *)) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationDidBecomeActiveNotification
                object:nil queue:NSOperationQueue.mainQueue usingBlock:^(__unused NSNotification *notification) {
                    hg_download_foreground();
                    hg_request_lease();
                }];
            if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive) {
                hg_download_foreground();
                hg_request_lease();
            }
        });
    }
#endif
}

int hg_download_status(void) {
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 260000
    if (@available(iOS 26.0, *)) {
        int current = atomic_load(&status);
        return current == HGUnsupported ? HGIdle : current;
    }
#endif
    return HGUnsupported;
}

void hg_request_background_download(void) {
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 260000
    if (@available(iOS 26.0, *)) {
        dispatch_async(dispatch_get_main_queue(), ^{ hg_request_lease(); });
    }
#endif
}
