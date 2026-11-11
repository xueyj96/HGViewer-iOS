#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

@interface HGCoverMenu : NSObject <UIContextMenuInteractionDelegate>
@property(nonatomic, weak) WKWebView *web;
@property(nonatomic, strong) UIContextMenuInteraction *interaction;
@property(nonatomic, copy) NSArray<NSDictionary *> *covers;
@property(nonatomic) uint64_t revision;
@property(nonatomic) BOOL history;
@property(nonatomic) CGRect previewRect;
@property(nonatomic) CGFloat previewRadius;
@end

@implementation HGCoverMenu

- (UIAction *)action:(NSString *)action
               title:(NSString *)title
              symbol:(NSString *)symbol
                  id:(NSNumber *)coverID
             episode:(NSNumber *)episode
          attributes:(UIMenuElementAttributes)attributes {
    __weak WKWebView *web = self.web;
    BOOL history = self.history;
    UIAction *result = [UIAction actionWithTitle:title image:[UIImage systemImageNamed:symbol]
        identifier:nil handler:^(__unused UIAction *item) {
            NSString *script = [NSString stringWithFormat:
                @"window.dispatchEvent(new CustomEvent('hg-cover-action',{detail:{id:%llu,history:%@,action:'%@',ep:%u}}));",
                coverID.unsignedLongLongValue, history ? @"true" : @"false", action, episode.unsignedIntValue];
            [web evaluateJavaScript:script completionHandler:nil];
        }];
    result.attributes = attributes;
    return result;
}

- (UIContextMenuConfiguration *)contextMenuInteraction:(UIContextMenuInteraction *)interaction
                         configurationForMenuAtLocation:(CGPoint)location {
    for (NSDictionary *cover in self.covers) {
        CGRect rect = CGRectMake([cover[@"x"] doubleValue], [cover[@"y"] doubleValue],
            [cover[@"width"] doubleValue], [cover[@"height"] doubleValue]);
        if (!CGRectContainsPoint(rect, location)) continue;
        NSNumber *coverID = cover[@"id"];
        NSNumber *episode = cover[@"ep"];
        NSString *downloadAction = cover[@"download_action"];
        NSMutableArray<UIMenuElement *> *actions = [NSMutableArray array];
        NSString *browseKind = cover[@"browse_kind"];
        if (browseKind) {
            BOOL isPost = [browseKind isEqualToString:@"post"];
            [actions addObject:[self action:@"browse-open" title:isPost ? @"查看图文" : @"播放剧集"
                symbol:isPost ? @"doc.text" : @"play.circle" id:coverID episode:nil attributes:0]];
            if (!isPost) {
                [actions addObject:[self action:@"browse-cache" title:@"缓存剧集" symbol:@"arrow.down.circle"
                    id:coverID episode:nil attributes:0]];
            }
        } else if (episode) {
            [actions addObject:[self action:@"delete-episode" title:@"删除本集缓存" symbol:@"trash"
                id:coverID episode:episode attributes:UIMenuElementAttributesDestructive]];
        } else if (downloadAction) {
            NSDictionary<NSString *, NSArray<NSString *> *> *labels = @{
                @"pause-download": @[@"暂停下载", @"pause.circle"],
                @"resume-download": @[@"继续下载", @"play.circle"],
                @"download-remaining": @[@"缓存剩余", @"arrow.down.circle"],
                @"stop-saving": @[@"停止保留", @"stop.circle"],
                @"all-cached": @[@"全部已缓存", @"checkmark.circle"],
            };
            NSArray<NSString *> *label = labels[downloadAction];
            if (label) {
                BOOL blocked = [cover[@"download_blocked"] boolValue];
                BOOL complete = [downloadAction isEqualToString:@"all-cached"];
                UIAction *item = [self action:downloadAction title:label[0] symbol:label[1]
                    id:coverID episode:nil attributes:(blocked || complete) ? UIMenuElementAttributesDisabled : 0];
                if (blocked) item.subtitle = @"等当前缓存任务结束后可用";
                [actions addObject:item];
            }
            [actions addObject:[self action:@"view-episodes" title:@"查看剧集" symbol:@"list.bullet"
                id:coverID episode:nil attributes:0]];
            if ([downloadAction isEqualToString:@"pause-download"] || [downloadAction isEqualToString:@"resume-download"]) {
                UIMenuElementAttributes attributes = UIMenuElementAttributesDestructive;
                if ([cover[@"download_blocked"] boolValue]) attributes |= UIMenuElementAttributesDisabled;
                [actions addObject:[self action:@"cancel-download" title:@"取消下载" symbol:@"xmark.circle"
                    id:coverID episode:nil attributes:attributes]];
            }
        } else {
            if (![cover[@"unavailable"] boolValue] && [cover[@"can_cache"] boolValue]) {
                [actions addObject:[self action:@"cache" title:@"缓存剧集" symbol:@"arrow.down.circle"
                    id:coverID episode:nil attributes:0]];
            }
            if (self.history && ![cover[@"unavailable"] boolValue]) {
                [actions addObject:[self action:@"restart" title:@"从头播放" symbol:@"play"
                    id:coverID episode:nil attributes:0]];
            }
            [actions addObject:[self action:@"remove" title:self.history ? @"移除这条记录" : @"取消收藏"
                symbol:self.history ? @"trash" : @"star.slash" id:coverID episode:nil attributes:UIMenuElementAttributesDestructive]];
        }
        NSDictionary *preview = cover[@"preview"];
        self.previewRect = preview ? CGRectMake([preview[@"x"] doubleValue], [preview[@"y"] doubleValue],
            [preview[@"width"] doubleValue], [preview[@"height"] doubleValue]) : rect;
        self.previewRadius = preview ? [preview[@"radius"] doubleValue] : 8;
        return [UIContextMenuConfiguration configurationWithIdentifier:coverID previewProvider:nil
            actionProvider:^UIMenu *(__unused NSArray<UIMenuElement *> *suggested) {
                return [UIMenu menuWithTitle:@"" children:actions];
            }];
    }
    return nil;
}

- (UITargetedPreview *)contextMenuInteraction:(UIContextMenuInteraction *)interaction
                                 configuration:(UIContextMenuConfiguration *)configuration
             highlightPreviewForItemWithIdentifier:(id<NSCopying>)identifier {
    WKWebView *web = self.web;
    CGRect rect = CGRectIntersection(self.previewRect, web.bounds);
    if (CGRectIsEmpty(rect)) return nil;
    UIView *preview = [web resizableSnapshotViewFromRect:rect afterScreenUpdates:NO withCapInsets:UIEdgeInsetsZero];
    if (!preview) return nil;
    UIPreviewParameters *parameters = [UIPreviewParameters new];
    parameters.backgroundColor = UIColor.clearColor;
    parameters.visiblePath = [UIBezierPath bezierPathWithRoundedRect:preview.bounds cornerRadius:self.previewRadius];
    UIPreviewTarget *target = [[UIPreviewTarget alloc] initWithContainer:web
        center:CGPointMake(CGRectGetMidX(rect), CGRectGetMidY(rect))];
    return [[UITargetedPreview alloc] initWithView:preview parameters:parameters target:target];
}

@end

static char coverMenuKey;

void hg_cover_menu_update(void *rawWeb, uint64_t revision, bool history, const char *json) {
    WKWebView *web = (__bridge WKWebView *)rawWeb;
    HGCoverMenu *menu = objc_getAssociatedObject(web, &coverMenuKey);
    if (menu && revision <= menu.revision) return;
    NSData *data = [NSData dataWithBytes:json length:strlen(json)];
    NSArray *covers = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    if (![covers isKindOfClass:NSArray.class]) return;
    if (!menu) {
        menu = [HGCoverMenu new];
        menu.web = web;
        objc_setAssociatedObject(web, &coverMenuKey, menu, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    menu.revision = revision;
    menu.history = history;
    menu.covers = covers;
    if (covers.count && !menu.interaction) {
        menu.interaction = [[UIContextMenuInteraction alloc] initWithDelegate:menu];
        [web addInteraction:menu.interaction];
    } else if (!covers.count && menu.interaction) {
        [menu.interaction dismissMenu];
        [web removeInteraction:menu.interaction];
        menu.interaction = nil;
    }
}
