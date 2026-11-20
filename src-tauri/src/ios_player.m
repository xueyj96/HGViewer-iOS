#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <math.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <stdint.h>

typedef struct {
    double time, duration, width, height;
    int32_t status, ready, app_state, error_domain, underlying_domain;
    int64_t error_code, underlying_code;
    double native_elapsed_ms, item_ready_ms, layer_ready_ms;
    int32_t warm_asset, standby_hit;
} HGPlayerSnapshot;

typedef enum {
    HGStatus, HGPlay, HGPause, HGSeek, HGRate, HGVolume, HGMute, HGClose, HGQuality,
    HGSlideOut, HGSlideIn, HGEdgePull, HGEpisodePull
} HGPlayerAction;

typedef struct { double x, y, width, height, top, bottom; bool viewport; } HGPlayerRect;
typedef struct { double close_ms, attach_ms; } HGPlayerOpenTiming;

static char itemReadyContext, layerReadyContext;

@interface HGStartupTiming : NSObject {
    CFTimeInterval _startedAt;
    _Atomic(int64_t) _itemReadyUs;
    _Atomic(int64_t) _layerReadyUs;
}
@property(nonatomic, copy) dispatch_block_t firstFrame;
- (double)elapsedMs;
- (void)writeToSnapshot:(HGPlayerSnapshot *)snapshot;
@end

static bool RecordFirstReady(_Atomic(int64_t) *time, CFTimeInterval start) {
    int64_t unset = -1;
    int64_t elapsed = llround((CACurrentMediaTime() - start) * 1000000);
    return atomic_compare_exchange_strong(time, &unset, elapsed);
}

@implementation HGStartupTiming
- (instancetype)init {
    self = [super init];
    if (self) {
        _startedAt = CACurrentMediaTime();
        atomic_init(&_itemReadyUs, -1);
        atomic_init(&_layerReadyUs, -1);
    }
    return self;
}

- (double)elapsedMs { return (CACurrentMediaTime() - _startedAt) * 1000; }

- (void)writeToSnapshot:(HGPlayerSnapshot *)snapshot {
    snapshot->item_ready_ms = atomic_load(&_itemReadyUs) / 1000.0;
    snapshot->layer_ready_ms = atomic_load(&_layerReadyUs) / 1000.0;
    snapshot->native_elapsed_ms = [self elapsedMs];
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object
                       change:(NSDictionary<NSKeyValueChangeKey, id> *)change context:(void *)context {
    NSNumber *value = change[NSKeyValueChangeNewKey];
    if (context == &itemReadyContext) {
        if (value.integerValue == AVPlayerItemStatusReadyToPlay) RecordFirstReady(&_itemReadyUs, _startedAt);
    } else if (context == &layerReadyContext) {
        if (value.boolValue && RecordFirstReady(&_layerReadyUs, _startedAt) && self.firstFrame) self.firstFrame();
    } else {
        [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
    }
}
@end

@interface HGPlayerView : UIView
@property(nonatomic, strong) AVPlayer *player;
@property(nonatomic, strong) HGStartupTiming *startupTiming;
@property(nonatomic, strong) AVPlayerItem *observedStartupItem;
@property(nonatomic) BOOL observingStartupLayer;
@property(nonatomic) int32_t warmAssetState;
@property(nonatomic) BOOL adoptedStandby;
- (void)stopStartupObservers;
@property(nonatomic, strong) UIView *slideBackdrop;
@property(nonatomic) NSUInteger slideVersion;
@property(nonatomic) CGPoint pullOffset;
@property(nonatomic, strong) NSURL *sourceURL;
@property(nonatomic) double pendingPosition;
@property(nonatomic) double seekTarget;
@property(nonatomic, strong) id endObserver;
@property(nonatomic) BOOL wantsPlay;
@property(nonatomic) BOOL seeking;
@property(nonatomic) BOOL ended;
@property(nonatomic) NSUInteger seekVersion;
@end

@implementation HGPlayerView
+ (Class)layerClass { return AVPlayerLayer.class; }

- (void)stopStartupObservers {
    [self.observedStartupItem removeObserver:self.startupTiming forKeyPath:@"status" context:&itemReadyContext];
    self.observedStartupItem = nil;
    if (self.observingStartupLayer) {
        [self.layer removeObserver:self.startupTiming forKeyPath:@"readyForDisplay" context:&layerReadyContext];
        self.observingStartupLayer = NO;
    }
}

- (void)dealloc { [self stopStartupObservers]; }
@end

static char playerKey, tokenKey, warmAssetsKey, standbyKey, standbyStatusContext;
static const NSTimeInterval HGStandbyLifetime = 12.0;
static const NSUInteger HGStandbyLimit = 2;

@interface HGStandbyPlayer : NSObject
@property(nonatomic, weak) WKWebView *web;
@property(nonatomic, strong) NSURL *url;
@property(nonatomic, strong) AVURLAsset *asset;
@property(nonatomic, strong) AVPlayer *player;
@property(nonatomic, strong) id backgroundObserver;
@property(nonatomic) uint64_t owner;
@property(nonatomic) BOOL observing;
@property(nonatomic) BOOL started;
@property(nonatomic) BOOL ready;
- (void)tryPreroll;
@end

static NSMutableArray<HGStandbyPlayer *> *Standbys(WKWebView *web) {
    return objc_getAssociatedObject(web, &standbyKey);
}

static HGStandbyPlayer *StandbyForURL(WKWebView *web, NSURL *url) {
    for (HGStandbyPlayer *candidate in Standbys(web)) {
        if ([candidate.url isEqual:url]) return candidate;
    }
    return nil;
}

static void StartNextStandby(WKWebView *web) {
    for (HGStandbyPlayer *candidate in Standbys(web).copy) {
        if (!candidate.ready) {
            [candidate tryPreroll];
            return;
        }
    }
}

static void CancelStandby(WKWebView *web, HGStandbyPlayer *candidate) {
    if (![Standbys(web) containsObject:candidate]) return;
    [Standbys(web) removeObjectIdenticalTo:candidate];
    [candidate.player cancelPendingPrerolls];
    StartNextStandby(web);
}

static void CancelAllStandbys(WKWebView *web) {
    NSArray<HGStandbyPlayer *> *candidates = Standbys(web);
    objc_setAssociatedObject(web, &standbyKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    for (HGStandbyPlayer *candidate in candidates) [candidate.player cancelPendingPrerolls];
}

static void ExpireStandby(WKWebView *web, HGStandbyPlayer *standby, NSTimeInterval after) {
    __weak WKWebView *weakWeb = web;
    __weak HGStandbyPlayer *weakStandby = standby;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(after * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        WKWebView *currentWeb = weakWeb;
        HGStandbyPlayer *candidate = weakStandby;
        if (currentWeb && candidate) CancelStandby(currentWeb, candidate);
    });
}

@implementation HGStandbyPlayer
- (void)tryPreroll {
    WKWebView *web = self.web;
    if (!web || ![Standbys(web) containsObject:self]) return;
    NSNumber *owner = objc_getAssociatedObject(web, &tokenKey);
    HGPlayerView *active = objc_getAssociatedObject(web, &playerKey);
    if (!active.wantsPlay || owner.unsignedLongLongValue != self.owner ||
        active.player.timeControlStatus != AVPlayerTimeControlStatusPlaying ||
        UIApplication.sharedApplication.applicationState != UIApplicationStateActive) return;
    if (!self.player) {
        AVPlayerItem *item = [AVPlayerItem playerItemWithAsset:self.asset];
        item.preferredForwardBufferDuration = 2;
        self.player = [AVPlayer playerWithPlayerItem:item];
        self.player.muted = YES;
        [self.player addObserver:self forKeyPath:@"status" options:0 context:&standbyStatusContext];
        [item addObserver:self forKeyPath:@"status" options:0 context:&standbyStatusContext];
        self.observing = YES;
    }
    if (self.player.status == AVPlayerStatusFailed ||
        self.player.currentItem.status == AVPlayerItemStatusFailed) {
        CancelStandby(web, self);
        return;
    }
    // AVPlayer raises if preroll is called before it is ready.
    if (self.started || self.player.status != AVPlayerStatusReadyToPlay ||
        self.player.currentItem.status != AVPlayerItemStatusReadyToPlay) return;
    self.started = YES;
    __weak HGStandbyPlayer *weakStandby = self;
    [self.player prerollAtRate:1.0 completionHandler:^(BOOL finished) {
        dispatch_async(dispatch_get_main_queue(), ^{
            HGStandbyPlayer *standby = weakStandby;
            WKWebView *currentWeb = standby.web;
            if (!currentWeb || ![Standbys(currentWeb) containsObject:standby]) return;
            if (finished) {
                standby.ready = YES;
                StartNextStandby(currentWeb);
            } else {
                CancelStandby(currentWeb, standby);
            }
        });
    }];
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object
                       change:(NSDictionary<NSKeyValueChangeKey, id> *)change context:(void *)context {
    if (context != &standbyStatusContext) {
        [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
        return;
    }
    __weak HGStandbyPlayer *weakStandby = self;
    dispatch_async(dispatch_get_main_queue(), ^{
        WKWebView *web = weakStandby.web;
        if (web) StartNextStandby(web);
    });
}

- (void)dealloc {
    if (self.observing) {
        [self.player removeObserver:self forKeyPath:@"status" context:&standbyStatusContext];
        [self.player.currentItem removeObserver:self forKeyPath:@"status" context:&standbyStatusContext];
    }
    if (self.backgroundObserver) [NSNotificationCenter.defaultCenter removeObserver:self.backgroundObserver];
}
@end

static void ClosePlayer(WKWebView *web) {
    HGPlayerView *view = objc_getAssociatedObject(web, &playerKey);
    if (!view) return;
    [view stopStartupObservers];
    view.wantsPlay = NO;
    view.seekVersion++;
    [view.player pause];
    [view.player.currentItem cancelPendingSeeks];
    if (view.endObserver) [NSNotificationCenter.defaultCenter removeObserver:view.endObserver];
    ((AVPlayerLayer *)view.layer).player = nil;
    [view.slideBackdrop removeFromSuperview];
    [view removeFromSuperview];
    objc_setAssociatedObject(web, &playerKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

static void PreparePlaybackHost(WKWebView *web, UIView *parent) {
    // The page paints its own theme. Keep the native surface black and the
    // WebView transparent even between player sessions, when no layer is ready.
    if (![parent.backgroundColor isEqual:UIColor.blackColor]) parent.backgroundColor = UIColor.blackColor;
    if (web.opaque) web.opaque = NO;
    if (![web.backgroundColor isEqual:UIColor.clearColor]) web.backgroundColor = UIColor.clearColor;
    if (![web.scrollView.backgroundColor isEqual:UIColor.clearColor]) web.scrollView.backgroundColor = UIColor.clearColor;
}

static void SetPullOffset(HGPlayerView *view, CGPoint offset) {
    CALayer *layer = view.layer;
    CGPoint center = layer.position;
    center.x += offset.x - view.pullOffset.x;
    center.y += offset.y - view.pullOffset.y;
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    layer.position = center;
    view.pullOffset = offset;
    [CATransaction commit];
}

static void Slide(HGPlayerView *view, double direction, BOOL entering) {
    if (UIAccessibilityIsReduceMotionEnabled() || !isfinite(direction) ||
        (direction != -2 && direction != -1 && direction != 0 && direction != 1 && direction != 2) || !view.superview) return;
    BOOL vertical = fabs(direction) == 2;
    CALayer *layer = view.layer;
    CGFloat start = 0;
    if (!entering && !vertical) {
        start = ((CALayer *)layer.presentationLayer ?: layer).position.x - layer.position.x + view.pullOffset.x;
        [layer removeAnimationForKey:@"hgEpisodeReturn"];
        SetPullOffset(view, CGPointMake(0, view.pullOffset.y));
    }
    if (!view.slideBackdrop) {
        UIView *backdrop = [[UIView alloc] initWithFrame:view.frame];
        backdrop.backgroundColor = UIColor.blackColor;
        backdrop.userInteractionEnabled = NO;
        backdrop.autoresizingMask = view.autoresizingMask;
        [view.superview insertSubview:backdrop belowSubview:view];
        view.slideBackdrop = backdrop;
    }
    CGFloat extent = vertical ? CGRectGetHeight(view.bounds) : CGRectGetWidth(view.bounds);
    CGFloat distance = extent * 0.24;
    if (start != 0) distance = fmax(distance, fabs(start) + extent * 0.12);
    double offset = distance * (direction < 0 ? -1 : direction > 0 ? 1 : 0);
    CABasicAnimation *translation = [CABasicAnimation animationWithKeyPath:
        vertical ? @"transform.translation.y" : @"transform.translation.x"];
    translation.fromValue = @(entering ? offset : start);
    translation.toValue = @(entering ? 0 : -offset);
    CABasicAnimation *opacity = [CABasicAnimation animationWithKeyPath:@"opacity"];
    opacity.fromValue = @(entering ? 0.15 : 1);
    opacity.toValue = @(entering ? 1 : 0.15);
    CAAnimationGroup *animation = [CAAnimationGroup animation];
    animation.animations = @[translation, opacity];
    animation.duration = entering ? 0.18 : 0.14;
    translation.duration = opacity.duration = animation.duration;
    animation.timingFunction = [CAMediaTimingFunction functionWithName:entering ? kCAMediaTimingFunctionEaseOut : kCAMediaTimingFunctionEaseIn];
    animation.fillMode = kCAFillModeForwards;
    animation.removedOnCompletion = entering;
    [CATransaction begin];
    NSUInteger slideVersion = ++view.slideVersion;
    if (entering) {
        __weak HGPlayerView *weakView = view;
        [CATransaction setCompletionBlock:^{
            HGPlayerView *current = weakView;
            if (current.slideVersion != slideVersion) return;
            [current.slideBackdrop removeFromSuperview];
            current.slideBackdrop = nil;
        }];
    }
    [view.layer addAnimation:animation forKey:@"hgEpisodeSlide"];
    [CATransaction commit];
}

static void PullEdge(HGPlayerView *view, double offset, BOOL horizontal) {
    if (!isfinite(offset)) return;
    BOOL reduceMotion = UIAccessibilityIsReduceMotionEnabled();
    CGFloat limit = horizontal ? CGRectGetWidth(view.bounds) * 0.85 : 36;
    CGFloat target = reduceMotion ? 0 : fmax(-limit, fmin(limit, offset));
    CGPoint next = view.pullOffset;
    if (horizontal) next.x = target;
    else next.y = target;
    if (CGPointEqualToPoint(next, view.pullOffset)) return;

    CALayer *layer = view.layer;
    CGPoint start = ((CALayer *)layer.presentationLayer ?: layer).position;
    NSString *key = horizontal ? @"hgEpisodeReturn" : @"hgEdgeReturn";
    [layer removeAnimationForKey:key];
    SetPullOffset(view, next);

    if (target == 0 && !reduceMotion) {
        CASpringAnimation *animation = [CASpringAnimation animationWithKeyPath:horizontal ? @"position.x" : @"position.y"];
        animation.fromValue = @(horizontal ? start.x : start.y);
        animation.toValue = @(horizontal ? layer.position.x : layer.position.y);
        animation.stiffness = 320;
        animation.damping = 31;
        animation.duration = animation.settlingDuration;
        [layer addAnimation:animation forKey:key];
    }
}

static NSURL *PlaybackURL(const char *source, BOOL local) {
    NSString *value = [NSString stringWithUTF8String:source];
    if (!value) return nil;
    return local ? [NSURL fileURLWithPath:value isDirectory:NO] : [NSURL URLWithString:value];
}

void hg_player_preload(void *rawWeb, const char *source, bool local) {
    WKWebView *web = (__bridge WKWebView *)rawWeb;
    NSURL *url = PlaybackURL(source, local);
    if (!url) return;
    NSMutableDictionary<NSURL *, AVURLAsset *> *assets = objc_getAssociatedObject(web, &warmAssetsKey);
    if (!assets) {
        assets = [NSMutableDictionary dictionary];
        objc_setAssociatedObject(web, &warmAssetsKey, assets, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    if (assets[url]) return;
    if (assets.count >= 4) {
        NSURL *evictedURL = assets.allKeys.firstObject;
        [assets[evictedURL] cancelLoading];
        [assets removeObjectForKey:evictedURL];
    }
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];
    assets[url] = asset;
    [asset loadValuesAsynchronouslyForKeys:@[@"playable"] completionHandler:nil];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (assets[url] == asset) {
            [asset cancelLoading];
            [assets removeObjectForKey:url];
        }
    });
}

void hg_player_prepare_standby(void *rawWeb, uint64_t owner, const char *source) {
    WKWebView *web = (__bridge WKWebView *)rawWeb;
    HGPlayerView *active = objc_getAssociatedObject(web, &playerKey);
    NSNumber *activeToken = objc_getAssociatedObject(web, &tokenKey);
    if (!active.wantsPlay || owner != activeToken.unsignedLongLongValue ||
        active.player.timeControlStatus != AVPlayerTimeControlStatusPlaying ||
        UIApplication.sharedApplication.applicationState != UIApplicationStateActive) return;
    NSURL *url = PlaybackURL(source, NO);
    if (!url || ![url.path hasSuffix:@"/master.m3u8"] || [active.sourceURL isEqual:url]) return;
    NSMutableArray<HGStandbyPlayer *> *candidates = Standbys(web);
    if (candidates.firstObject && candidates.firstObject.owner != owner) {
        CancelAllStandbys(web);
        candidates = nil;
    }
    if (StandbyForURL(web, url) || candidates.count >= HGStandbyLimit) return;
    if (!candidates) {
        candidates = [NSMutableArray arrayWithCapacity:HGStandbyLimit];
        objc_setAssociatedObject(web, &standbyKey, candidates, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }

    NSMutableDictionary<NSURL *, AVURLAsset *> *assets = objc_getAssociatedObject(web, &warmAssetsKey);
    AVURLAsset *asset = assets[url];
    AVKeyValueStatus status = [asset statusOfValueForKey:@"playable" error:nil];
    if (!asset || status == AVKeyValueStatusFailed || status == AVKeyValueStatusCancelled) {
        asset = [AVURLAsset URLAssetWithURL:url options:nil];
    }
    // Do not leave the asset in the metadata cache: eviction there cancels loading.
    [assets removeObjectForKey:url];
    HGStandbyPlayer *standby = [HGStandbyPlayer new];
    standby.web = web;
    standby.url = url;
    standby.owner = owner;
    standby.asset = asset;
    [candidates addObject:standby];
    __weak WKWebView *weakWeb = web;
    __weak HGStandbyPlayer *weakStandby = standby;
    standby.backgroundObserver = [NSNotificationCenter.defaultCenter
        addObserverForName:UIApplicationDidEnterBackgroundNotification object:nil queue:NSOperationQueue.mainQueue
        usingBlock:^(__unused NSNotification *note) {
            WKWebView *currentWeb = weakWeb;
            HGStandbyPlayer *candidate = weakStandby;
            if (currentWeb && candidate && [Standbys(currentWeb) containsObject:candidate])
                CancelAllStandbys(currentWeb);
        }];
    ExpireStandby(web, standby, HGStandbyLifetime);
    StartNextStandby(web);
}

static void ObserveItem(HGPlayerView *view, AVPlayerItem *item, BOOL measureStartup) {
    if (measureStartup) {
        [item addObserver:view.startupTiming forKeyPath:@"status"
                  options:NSKeyValueObservingOptionInitial | NSKeyValueObservingOptionNew context:&itemReadyContext];
        view.observedStartupItem = item;
    }
    __weak HGPlayerView *weakView = view;
    view.endObserver = [NSNotificationCenter.defaultCenter
        addObserverForName:AVPlayerItemDidPlayToEndTimeNotification object:item queue:NSOperationQueue.mainQueue
        usingBlock:^(__unused NSNotification *note) {
            HGPlayerView *current = weakView;
            if (current.player.currentItem != item) return;
            current.ended = YES;
            current.wantsPlay = NO;
        }];
}

static void SetItem(HGPlayerView *view, NSURL *url, AVURLAsset *warmAsset, BOOL measureStartup) {
    [view stopStartupObservers];
    if (view.endObserver) [NSNotificationCenter.defaultCenter removeObserver:view.endObserver];
    [view.player.currentItem cancelPendingSeeks];
    view.seekVersion++;
    view.seeking = NO;
    view.ended = NO;
    AVPlayerItem *item = warmAsset ? [AVPlayerItem playerItemWithAsset:warmAsset] : [AVPlayerItem playerItemWithURL:url];
    ObserveItem(view, item, measureStartup);
    [view.player replaceCurrentItemWithPlayerItem:item];
}

static void Seek(HGPlayerView *view, double target, BOOL resume) {
    AVPlayer *player = view.player;
    AVPlayerItem *item = player.currentItem;
    double duration = CMTimeGetSeconds(item.duration);
    target = isfinite(duration) ? fmin(fmax(target, 0), duration) : fmax(target, 0);
    view.ended = NO;
    view.seeking = YES;
    view.seekTarget = target;
    view.wantsPlay = resume;
    NSUInteger seekVersion = ++view.seekVersion;
    [player pause];
    [item cancelPendingSeeks];
    __weak HGPlayerView *weakView = view;
    [player seekToTime:CMTimeMakeWithSeconds(target, 600)
        toleranceBefore:CMTimeMakeWithSeconds(0.05, 600)
        toleranceAfter:CMTimeMakeWithSeconds(0.05, 600)
        completionHandler:^(__unused BOOL finished) {
            dispatch_async(dispatch_get_main_queue(), ^{
                HGPlayerView *current = weakView;
                if (!current || current.seekVersion != seekVersion) return;
                current.seeking = NO;
                if (current.wantsPlay) [current.player play];
            });
        }];
}

bool hg_player_open(void *rawWeb, uint64_t token, const char *source, bool local,
                    HGPlayerOpenTiming *timing) {
    WKWebView *web = (__bridge WKWebView *)rawWeb;
    UIView *parent = web.superview;
    NSNumber *previousToken = objc_getAssociatedObject(web, &tokenKey);
    if (!parent || (previousToken && token <= previousToken.unsignedLongLongValue)) return false;
    CFTimeInterval started = CACurrentMediaTime();
    ClosePlayer(web);
    CFTimeInterval attaching = CACurrentMediaTime();
    timing->close_ms = (attaching - started) * 1000;
    objc_setAssociatedObject(web, &tokenKey, @(token), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    NSURL *url = PlaybackURL(source, local);
    if (!url) return false;

    HGPlayerView *view = [[HGPlayerView alloc] initWithFrame:web.frame];
    view.startupTiming = [HGStartupTiming new];
    __weak WKWebView *weakWeb = web;
    __weak HGPlayerView *weakView = view;
    view.startupTiming.firstFrame = ^{
        dispatch_async(dispatch_get_main_queue(), ^{
            WKWebView *target = weakWeb;
            HGPlayerView *player = weakView;
            if (!target || !player) return;
            NSNumber *currentToken = objc_getAssociatedObject(target, &tokenKey);
            if (currentToken.unsignedLongLongValue != token ||
                objc_getAssociatedObject(target, &playerKey) != player || !((AVPlayerLayer *)player.layer).readyForDisplay) return;
            NSString *event = [NSString stringWithFormat:
                @"window.dispatchEvent(new CustomEvent('hg-ios-first-frame', {detail:%llu}))",
                (unsigned long long)token];
            [target evaluateJavaScript:event completionHandler:nil];
        });
    };
    view.userInteractionEnabled = NO;
    view.hidden = YES;
    view.backgroundColor = UIColor.blackColor;
    view.sourceURL = url;
    HGStandbyPlayer *standby = StandbyForURL(web, url);
    if (standby.ready &&
        standby.player.status == AVPlayerStatusReadyToPlay &&
        standby.player.currentItem.status == AVPlayerItemStatusReadyToPlay &&
        UIApplication.sharedApplication.applicationState == UIApplicationStateActive) {
        view.player = standby.player;
        view.player.currentItem.preferredForwardBufferDuration = 0;
        view.adoptedStandby = YES;
        [Standbys(web) removeObjectIdenticalTo:standby];
        ObserveItem(view, view.player.currentItem, YES);
    } else {
        view.player = [AVPlayer new];
    }
    CancelAllStandbys(web);
    NSMutableDictionary<NSURL *, AVURLAsset *> *assets = objc_getAssociatedObject(web, &warmAssetsKey);
    AVURLAsset *warmAsset = assets[url];
    [assets removeObjectForKey:url];
    if (warmAsset) {
        AVKeyValueStatus status = [warmAsset statusOfValueForKey:@"playable" error:nil];
        if (status == AVKeyValueStatusFailed || status == AVKeyValueStatusCancelled) warmAsset = nil;
        else view.warmAssetState = status == AVKeyValueStatusLoaded ? 2 : 1;
    }
    if (!view.adoptedStandby) SetItem(view, url, warmAsset, YES);
    AVPlayerLayer *layer = (AVPlayerLayer *)view.layer;
    [layer addObserver:view.startupTiming forKeyPath:@"readyForDisplay"
               options:NSKeyValueObservingOptionInitial | NSKeyValueObservingOptionNew context:&layerReadyContext];
    view.observingStartupLayer = YES;
    layer.player = view.player;
    layer.videoGravity = AVLayerVideoGravityResizeAspect;
    PreparePlaybackHost(web, parent);
    [parent insertSubview:view belowSubview:web];
    objc_setAssociatedObject(web, &playerKey, view, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    timing->attach_ms = (CACurrentMediaTime() - attaching) * 1000;
    return true;
}

void hg_player_frame(void *rawWeb, uint64_t token, const HGPlayerRect *rect) {
    WKWebView *web = (__bridge WKWebView *)rawWeb;
    NSNumber *activeToken = objc_getAssociatedObject(web, &tokenKey);
    HGPlayerView *view = objc_getAssociatedObject(web, &playerKey);
    if (!view || token != activeToken.unsignedLongLongValue || !web.superview) return;
    CGRect frame = rect->viewport ? web.bounds : CGRectMake(rect->x, rect->y, rect->width, rect->height);
    CGRect clip = rect->viewport ? web.bounds :
        CGRectMake(0, rect->top, web.bounds.size.width, MAX(0, rect->bottom - rect->top));
    CGRect visible = CGRectIntersection(frame, CGRectIntersection(web.bounds, clip));
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    view.hidden = CGRectIsEmpty(visible);
    if (!view.hidden) {
        view.autoresizingMask = rect->viewport ? web.autoresizingMask : UIViewAutoresizingNone;
        view.frame = CGRectOffset([web convertRect:frame toView:web.superview], view.pullOffset.x, view.pullOffset.y);
        if (CGRectEqualToRect(visible, frame)) view.layer.mask = nil;
        else {
            CAShapeLayer *mask = (CAShapeLayer *)view.layer.mask ?: [CAShapeLayer layer];
            mask.path = [UIBezierPath bezierPathWithRect:CGRectOffset(visible, -frame.origin.x, -frame.origin.y)].CGPath;
            if (view.layer.mask != mask) view.layer.mask = mask;
        }
    }
    [CATransaction commit];
}

// Keep diagnostics numeric. NSError descriptions and userInfo may contain media URLs.
static int32_t ErrorDomain(NSError *error) {
    if (!error) return 0;
    if ([error.domain isEqualToString:AVFoundationErrorDomain]) return 1;
    if ([error.domain isEqualToString:NSURLErrorDomain]) return 2;
    if ([error.domain isEqualToString:@"CoreMediaErrorDomain"]) return 3;
    if ([error.domain isEqualToString:NSPOSIXErrorDomain]) return 4;
    return 5;
}

bool hg_player_control(void *rawWeb, uint64_t token, int32_t action, double value,
                       bool resume, HGPlayerSnapshot *out) {
    WKWebView *web = (__bridge WKWebView *)rawWeb;
    NSNumber *activeToken = objc_getAssociatedObject(web, &tokenKey);
    if (action == HGClose && (!activeToken || token >= activeToken.unsignedLongLongValue)) {
        // A normal media switch closes the outgoing surface before opening the next.
        for (HGStandbyPlayer *candidate in Standbys(web)) {
            if (candidate.owner == token) ExpireStandby(web, candidate, 1.0);
        }
        ClosePlayer(web);
        objc_setAssociatedObject(web, &tokenKey, @(token), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        return true;
    }
    HGPlayerView *view = objc_getAssociatedObject(web, &playerKey);
    if (!view || token != activeToken.unsignedLongLongValue) return false;
    AVPlayer *player = view.player;
    AVPlayerItem *item = player.currentItem;
    switch (action) {
        case HGPlay:
            if (view.ended) {
                view.ended = NO;
                [player seekToTime:kCMTimeZero];
            }
            view.wantsPlay = YES;
            if (!view.seeking) [player play];
            break;
        case HGPause:
            if (Standbys(web).firstObject.owner == token) CancelAllStandbys(web);
            view.wantsPlay = NO;
            [player pause];
            break;
        case HGSeek:
            if (isfinite(value) && item.status == AVPlayerItemStatusReadyToPlay) {
                Seek(view, value, resume || view.wantsPlay);
            }
            break;
        case HGQuality: {
            if (!isfinite(value) || value < -1 || value > 100 || ![view.sourceURL.path hasSuffix:@"/master.m3u8"]) break;
            double current = CMTimeGetSeconds(player.currentTime);
            if (isfinite(current) && current > 0) view.pendingPosition = current;
            NSURLComponents *components = [NSURLComponents componentsWithURL:view.sourceURL resolvingAgainstBaseURL:NO];
            if (value >= 0) components.queryItems = @[[NSURLQueryItem queryItemWithName:@"level"
                value:[NSString stringWithFormat:@"%d", (int)value]]];
            [player pause];
            SetItem(view, components.URL, nil, NO);
            item = player.currentItem;
            if (view.wantsPlay && view.pendingPosition == 0) [player play];
            break;
        }
        case HGRate:
            if (isfinite(value) && value >= 0.5 && value <= 3) {
                player.defaultRate = (float)value;
                if (view.wantsPlay && !view.seeking) [player play];
            }
            break;
        case HGVolume:
            if (isfinite(value)) player.volume = (float)fmin(fmax(value, 0), 1);
            break;
        case HGMute:
            player.muted = value != 0;
            break;
        case HGSlideOut:
        case HGSlideIn:
            Slide(view, value, action == HGSlideIn);
            break;
        case HGEdgePull:
        case HGEpisodePull:
            PullEdge(view, value, action == HGEpisodePull);
            break;
        default:
            break;
    }

    if (view.pendingPosition > 0 && item.status == AVPlayerItemStatusReadyToPlay) {
        double position = view.pendingPosition;
        view.pendingPosition = 0;
        Seek(view, position, view.wantsPlay);
    }
    double time = CMTimeGetSeconds(player.currentTime);
    double duration = CMTimeGetSeconds(item.duration);
    CGSize size = item.presentationSize;
    out->time = view.pendingPosition > 0 ? view.pendingPosition :
        (view.seeking ? view.seekTarget : (isfinite(time) ? time : 0));
    out->duration = isfinite(duration) ? duration : 0;
    out->width = size.width;
    out->height = size.height;
    out->ready = ((AVPlayerLayer *)view.layer).readyForDisplay;
    [view.startupTiming writeToSnapshot:out];
    out->warm_asset = view.warmAssetState;
    out->standby_hit = view.adoptedStandby;
    if (Standbys(web).firstObject.owner == token && player.timeControlStatus == AVPlayerTimeControlStatusWaitingToPlayAtSpecifiedRate)
        CancelAllStandbys(web);
    out->app_state = (int32_t)UIApplication.sharedApplication.applicationState;
    if (player.status == AVPlayerStatusFailed || item.status == AVPlayerItemStatusFailed) {
        out->status = -1;
        NSError *error = item.error ?: player.error;
        id underlying = error.userInfo[NSUnderlyingErrorKey];
        NSError *cause = [underlying isKindOfClass:NSError.class] ? underlying : nil;
        out->error_domain = ErrorDomain(error);
        out->error_code = error.code;
        out->underlying_domain = ErrorDomain(cause);
        out->underlying_code = cause.code;
    } else if (view.ended) out->status = 4;
    else if (view.pendingPosition > 0 || view.seeking || (view.wantsPlay && player.timeControlStatus == AVPlayerTimeControlStatusWaitingToPlayAtSpecifiedRate)) out->status = 3;
    else if (item.status != AVPlayerItemStatusReadyToPlay) out->status = 0;
    else out->status = player.timeControlStatus == AVPlayerTimeControlStatusPlaying ? 2 : 1;
    return true;
}
