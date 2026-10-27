#import "RNLander.h"

#if __has_include(<RNLander/RNLander-Swift.h>)
#import <RNLander/RNLander-Swift.h>
#else
#import "RNLander-Swift.h"
#endif

// Links reach JavaScript through React Native's Linking (RCTLinkingManager), so
// this module only provides platform info and backup-excluded storage on iOS.
@implementation RNLander {
  RNLanderImpl *_impl;
}

RCT_EXPORT_MODULE(RNLander)

- (instancetype)init
{
  if (self = [super init]) {
    _impl = [RNLanderImpl new];
  }
  return self;
}

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (facebook::react::ModuleConstants<JS::NativeRNLander::Constants>)constantsToExport
{
  return [self getConstants];
}

- (facebook::react::ModuleConstants<JS::NativeRNLander::Constants>)getConstants
{
  return facebook::react::typedConstants<JS::NativeRNLander::Constants>({
      .appVersion = [RNLanderImpl appVersion],
      .osVersion = [RNLanderImpl osVersion],
  });
}

RCT_EXPORT_METHOD(getInitialLink : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  // iOS launch links come from Linking.getInitialURL.
  resolve([NSNull null]);
}

RCT_EXPORT_METHOD(getInstallReferrer : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  // Android only.
  resolve([NSNull null]);
}

RCT_EXPORT_METHOD(storageRead : (NSString *)key resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)
                      reject)
{
  [_impl read:key resolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(storageWrite : (NSString *)key value : (NSString *)value resolve : (RCTPromiseResolveBlock)
                      resolve reject : (RCTPromiseRejectBlock)reject)
{
  [_impl write:key value:value resolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(storageDelete : (NSString *)key resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)
                      reject)
{
  [_impl remove:key resolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(addListener : (NSString *)eventName)
{
  // No native events on iOS.
}

RCT_EXPORT_METHOD(removeListeners : (double)count)
{
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeRNLanderSpecJSI>(params);
}

@end
