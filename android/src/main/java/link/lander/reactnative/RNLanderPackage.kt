package link.lander.reactnative

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/** Registers [RNLanderModule]. Autolinked; apps never add it by hand. */
class RNLanderPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == RNLanderModule.NAME) RNLanderModule(reactContext) else null

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
      RNLanderModule.NAME to ReactModuleInfo(
        name = RNLanderModule.NAME,
        className = RNLanderModule.NAME,
        canOverrideExistingModule = false,
        // Created at startup, so onNewIntent is observed even before
        // JavaScript first touches the module.
        needsEagerInit = true,
        isCxxModule = false,
        isTurboModule = true,
      ),
    )
  }
}
