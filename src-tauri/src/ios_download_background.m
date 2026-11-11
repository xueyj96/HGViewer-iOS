#import <UIKit/UIKit.h>
#import <BackgroundTasks/BackgroundTasks.h>
#include <stdint.h>
#include <stdatomic.h>

enum {
    HGUnsupported, HGIdle, HGWaiting, HGRunning, HGUnavailable, HGExpired,
};

static _Atomic int status = HGUnsupported;
extern void hg_download_foreground(void);
extern void hg_download_enter_background(void);
extern int hg_download_background_allowed(void);

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
extern void hg_download_log(int event, int64_t code);
extern int hg_download_has_background_work(void);
extern int hg_download_resume_background(void);

enum {
    HGLogRegistered = 1, HGLogRegistrationFailed, HGLogSubmissionFailed, HGLogRunning,
    HGLogExpiredActive, HGLogExpiredInactive, HGLogFinished,
    HGLogRecoveryScheduled, HGLogRecoverySubmissionFailed,
    HGLogRecoveryExpired, HGLogRecoveryFinished,
};

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
static BGProcessingTask *recoveryTask;
static NSTimer *recoveryTimer;
static BOOL recoveryRegistered;

static NSString *hg_recovery_identifier(void) {
    return [NSBundle.mainBundle.bundleIdentifier stringByAppendingString:@".download-recovery"];
}

static void hg_schedule_download_recovery(void) {
    if (!hg_download_has_background_work()) return;
    if (!recoveryRegistered) {
        hg_download_log(HGLogRecoverySubmissionFailed, -1);
        return;
    }
    BGProcessingTaskRequest *request = [[BGProcessingTaskRequest alloc]
        initWithIdentifier:hg_recovery_identifier()];
    request.requiresNetworkConnectivity = YES;
    request.earliestBeginDate = [NSDate dateWithTimeIntervalSinceNow:120];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    NSError *error = nil;
    BOOL submitted = [BGTaskScheduler.sharedScheduler submitTaskRequest:request error:&error];
#pragma clang diagnostic pop
    hg_download_log(submitted ? HGLogRecoveryScheduled : HGLogRecoverySubmissionFailed, error.code);
}

static void hg_finish_download_recovery(BOOL success) {
    BGProcessingTask *task = recoveryTask;
    if (!task) return;
    recoveryTask = nil;
    [recoveryTimer invalidate];
    recoveryTimer = nil;
    task.expirationHandler = nil;
    [task setTaskCompletedWithSuccess:success];
    atomic_store(&status, success ? HGIdle : HGExpired);
}

static void hg_register_download_recovery(void) API_AVAILABLE(ios(26.0));
static void hg_register_download_recovery(void) {
    recoveryRegistered = [BGTaskScheduler.sharedScheduler registerForTaskWithIdentifier:hg_recovery_identifier()
        usingQueue:dispatch_get_main_queue() launchHandler:^(BGTask *task) {
            if (![task isKindOfClass:BGProcessingTask.class] || recoveryTask) {
                [task setTaskCompletedWithSuccess:NO];
                return;
            }
            HGDownloadSnapshot initial = {0};
            hg_download_snapshot(&initial);
            if (lease || UIApplication.sharedApplication.applicationState == UIApplicationStateActive ||
                !hg_download_resume_background()) {
                [task setTaskCompletedWithSuccess:YES];
                return;
            }
            recoveryTask = (BGProcessingTask *)task;
            atomic_store(&status, HGRunning);
            __weak BGTask *weakTask = task;
            task.expirationHandler = ^{
                dispatch_async(dispatch_get_main_queue(), ^{
                    BGTask *expired = weakTask;
                    if (!expired || recoveryTask != expired) return;
                    if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive) {
                        hg_download_expired();
                        hg_schedule_download_recovery();
                    }
                    hg_download_log(HGLogRecoveryExpired, 0);
                    hg_finish_download_recovery(NO);
                });
            };
            recoveryTimer = [NSTimer timerWithTimeInterval:1 repeats:YES block:^(__unused NSTimer *timer) {
                HGDownloadSnapshot snapshot = {0};
                hg_download_snapshot(&snapshot);
                if (snapshot.remaining) return;
                BOOL retryPending = hg_download_has_background_work() != 0;
                if (retryPending) hg_schedule_download_recovery();
                hg_download_log(HGLogRecoveryFinished, 0);
                hg_finish_download_recovery(!retryPending && snapshot.failed == initial.failed);
            }];
            [NSRunLoop.mainRunLoop addTimer:recoveryTimer forMode:NSRunLoopCommonModes];
        }];
}

// Called from the iOS entry point before Tauri enters UIApplicationMain.
void hg_register_download_launch(void) {
    @autoreleasepool {
        if (@available(iOS 26.0, *)) {
            hg_register_download_recovery();
        }
    }
}

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
        hg_download_log(HGLogFinished, success);
        if (UIApplication.sharedApplication.applicationState == UIApplicationStateBackground) {
            hg_schedule_download_recovery();
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
    if (lease || !hg_download_background_allowed() ||
        UIApplication.sharedApplication.applicationState != UIApplicationStateActive) return;
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
        if (!hg_download_background_allowed()) {
            [running finish:HGIdle success:YES];
            return;
        }
        __weak HGDownloadLease *weakRunning = running;
        task.expirationHandler = ^{
            dispatch_async(dispatch_get_main_queue(), ^{
                HGDownloadLease *expired = weakRunning;
                if (!expired || lease != expired) return;
                [expired update];
                if (expired.finished) return;
                BOOL foreground = UIApplication.sharedApplication.applicationState == UIApplicationStateActive;
                hg_download_log(foreground ? HGLogExpiredActive : HGLogExpiredInactive, 0);
                if (!foreground) {
                    if (hg_download_background_allowed()) {
                        hg_download_expired();
                        hg_schedule_download_recovery();
                    } else hg_download_enter_background();
                }
                [expired.task updateTitle:@"HGViewer 后台下载"
                                 subtitle:foreground ? @"下载在 App 内继续" : @"后台已中断，回 App 自动继续"];
                [expired finish:foreground ? HGIdle : HGExpired success:NO];
            });
        };
        atomic_store(&status, HGRunning);
        hg_download_log(HGLogRunning, 0);
        [running update];
    }];
    if (!registered) {
        atomic_store(&status, HGUnavailable);
        hg_download_log(HGLogRegistrationFailed, 0);
        return;
    }

    lease = current;
    atomic_store(&status, HGWaiting);
    hg_download_log(HGLogRegistered, 0);
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
                    if (error && !submitted.task) {
                        hg_download_log(HGLogSubmissionFailed, error.code);
                        [submitted finish:HGUnavailable success:NO];
                    }
                });
            }];
        });
        return;
    }
#endif
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    NSError *error = nil;
    if (![scheduler submitTaskRequest:request error:&error]) {
        hg_download_log(HGLogSubmissionFailed, error.code);
        [current finish:HGUnavailable success:NO];
    }
#pragma clang diagnostic pop
}
#endif

static void hg_resume_downloads(void) {
    hg_download_foreground();
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 260000
    if (@available(iOS 26.0, *)) {
        [BGTaskScheduler.sharedScheduler cancelTaskRequestWithIdentifier:hg_recovery_identifier()];
        hg_finish_download_recovery(YES);
        hg_request_lease();
    }
#endif
}

void hg_observe_download_foreground(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationDidBecomeActiveNotification
            object:nil queue:NSOperationQueue.mainQueue usingBlock:^(__unused NSNotification *notification) {
                hg_resume_downloads();
            }];
        [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationDidEnterBackgroundNotification
            object:nil queue:NSOperationQueue.mainQueue usingBlock:^(__unused NSNotification *notification) {
                hg_download_enter_background();
            }];
        UIApplicationState state = UIApplication.sharedApplication.applicationState;
        if (state == UIApplicationStateActive) hg_resume_downloads();
        else if (state == UIApplicationStateBackground) hg_download_enter_background();
    });
}

void hg_refresh_download_background_policy(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (UIApplication.sharedApplication.applicationState == UIApplicationStateBackground) {
            hg_download_enter_background();
        }
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 260000
        if (@available(iOS 26.0, *)) {
            if (hg_download_background_allowed()) hg_request_lease();
            else {
                [BGTaskScheduler.sharedScheduler cancelTaskRequestWithIdentifier:hg_recovery_identifier()];
                hg_finish_download_recovery(YES);
                [lease finish:HGIdle success:YES];
            }
        }
#endif
    });
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

#if __IPHONE_OS_VERSION_MAX_ALLOWED < 260000
void hg_register_download_launch(void) {}
#endif
