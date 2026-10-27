package link.lander.reactnative

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Native side of react-native-lander on Android.
 *
 * Delivers App Links and custom scheme URLs (the launch intent once, then
 * `onNewIntent` and the launch intent of any new activity) to JavaScript as
 * `LanderLink` device events, reads the Play Install Referrer, and stores the
 * SDK's small state in noBackupFilesDir so it is never restored onto another
 * device.
 */
class RNLanderModule(reactContext: ReactApplicationContext) :
  NativeRNLanderSpec(reactContext), ActivityEventListener, LifecycleEventListener {

  private val mainHandler = Handler(Looper.getMainLooper())
  private val io: ExecutorService = Executors.newSingleThreadExecutor()

  // Link delivery state. Only touched on the main thread.
  private var initialLinkRequested = false
  private var lastActivity: WeakReference<Activity>? = null
  private val waitingForActivity = mutableListOf<Promise>()
  private val pending = ArrayDeque<String>()

  init {
    (reactContext.applicationContext as? Application)?.let(LaunchTracker::register)
    reactContext.addActivityEventListener(this)
    reactContext.addLifecycleEventListener(this)
  }

  override fun invalidate() {
    reactApplicationContext.removeActivityEventListener(this)
    reactApplicationContext.removeLifecycleEventListener(this)
    io.shutdown()
    super.invalidate()
  }

  // Constants

  override fun getTypedExportedConstants(): Map<String, Any> =
    mapOf("appVersion" to appVersion(), "osVersion" to (Build.VERSION.RELEASE ?: ""))

  private fun appVersion(): String = try {
    val context = reactApplicationContext
    val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
    } else {
      @Suppress("DEPRECATION")
      context.packageManager.getPackageInfo(context.packageName, 0)
    }
    info.versionName ?: "0.0.0"
  } catch (e: Exception) {
    "0.0.0"
  }

  // Links

  override fun getInitialLink(promise: Promise) {
    mainHandler.post {
      val activity = reactApplicationContext.currentActivity
      if (activity == null) {
        // Called before the activity resumed; answer from onHostResume.
        waitingForActivity.add(promise)
      } else {
        answerInitialLink(activity, promise)
      }
    }
  }

  /** Main thread. The first call gets the launch link, later calls null. */
  private fun answerInitialLink(activity: Activity, promise: Promise) {
    val link = if (initialLinkRequested) null else launchLink(activity)
    initialLinkRequested = true
    lastActivity = WeakReference(activity)
    promise.resolve(link)
    // JavaScript listens for link events before it asks for the launch link,
    // so links that arrived meanwhile can go out now.
    while (pending.isNotEmpty()) emit(pending.removeFirst())
  }

  /** The launch link of [activity], unless it was delivered before. */
  private fun launchLink(activity: Activity): String? {
    if (LaunchTracker.isHandled(activity)) return null
    LaunchTracker.markHandled(activity)
    return linkFrom(activity.intent, isLaunchIntent = true)
  }

  private fun linkFrom(intent: Intent?, isLaunchIntent: Boolean): String? {
    if (intent == null || intent.action != Intent.ACTION_VIEW) return null
    // Reopening from Recents replays the original intent. It was handled already.
    if (isLaunchIntent && (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return null
    return intent.dataString?.takeIf { it.isNotEmpty() }
  }

  private fun emit(link: String) {
    if (!initialLinkRequested) {
      pending.addLast(link)
      return
    }
    try {
      reactApplicationContext.emitDeviceEvent(LINK_EVENT, link)
    } catch (e: Exception) {
      Log.w(TAG, "Could not deliver a link: ${e.message}")
    }
  }

  // ActivityEventListener (warm start)

  override fun onNewIntent(intent: Intent) {
    linkFrom(intent, isLaunchIntent = false)?.let { link -> mainHandler.post { emit(link) } }
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) = Unit

  // LifecycleEventListener

  override fun onHostResume() {
    val activity = reactApplicationContext.currentActivity ?: return
    if (waitingForActivity.isNotEmpty()) {
      val promises = waitingForActivity.toList()
      waitingForActivity.clear()
      for (promise in promises) answerInitialLink(activity, promise)
      return
    }
    if (!initialLinkRequested || lastActivity?.get() === activity) return
    // A new activity on this running React instance (the previous one was
    // finished, for example with the back button) has its own launch intent.
    lastActivity = WeakReference(activity)
    launchLink(activity)?.let(::emit)
  }

  override fun onHostPause() = Unit

  override fun onHostDestroy() = Unit

  // Event emitter bookkeeping required by the spec. Events go out through
  // emitDeviceEvent, so there is nothing to count.

  override fun addListener(eventName: String) = Unit

  override fun removeListeners(count: Double) = Unit

  // Install referrer

  override fun getInstallReferrer(promise: Promise) {
    val replied = AtomicBoolean(false)
    fun reply(value: String?) {
      if (replied.compareAndSet(false, true)) promise.resolve(value)
    }
    mainHandler.post { connectInstallReferrer(retriesLeft = 1, ::reply) }
  }

  private fun connectInstallReferrer(retriesLeft: Int, reply: (String?) -> Unit) {
    val client = try {
      InstallReferrerClient.newBuilder(reactApplicationContext).build()
    } catch (e: Exception) {
      reply(null)
      return
    }
    val done = AtomicBoolean(false)
    fun finish(value: String?, retry: Boolean = false) {
      if (!done.compareAndSet(false, true)) return
      try {
        client.endConnection()
      } catch (_: Exception) {
      }
      if (retry) {
        // The Play Store service was busy or updating. Try once more shortly.
        mainHandler.postDelayed({ connectInstallReferrer(retriesLeft - 1, reply) }, 1000)
      } else {
        reply(value)
      }
    }
    try {
      client.startConnection(object : InstallReferrerStateListener {
        override fun onInstallReferrerSetupFinished(responseCode: Int) {
          when (responseCode) {
            InstallReferrerClient.InstallReferrerResponse.OK -> {
              // getInstallReferrer is a binder call; keep it off the main thread.
              try {
                io.execute {
                  val referrer = try {
                    client.installReferrer.installReferrer
                  } catch (e: Exception) {
                    Log.w(TAG, "Install referrer unavailable: ${e.message}")
                    null
                  }
                  mainHandler.post { finish(referrer) }
                }
              } catch (e: RejectedExecutionException) {
                finish(null)
              }
            }
            InstallReferrerClient.InstallReferrerResponse.SERVICE_UNAVAILABLE ->
              finish(null, retry = retriesLeft > 0)
            else -> finish(null)
          }
        }

        override fun onInstallReferrerServiceDisconnected() {
          finish(null, retry = retriesLeft > 0)
        }
      })
    } catch (e: Exception) {
      // Thrown on devices without the Play Store or with a broken one.
      Log.w(TAG, "Install referrer connection failed: ${e.message}")
      finish(null)
    }
  }

  // Storage

  override fun storageRead(key: String, promise: Promise) =
    storage(key, promise) { file -> if (file.exists()) file.readText() else null }

  override fun storageWrite(key: String, value: String, promise: Promise) =
    storage(key, promise) { file ->
      val tmp = File(file.parentFile, "${file.name}.tmp")
      tmp.writeText(value)
      if (!tmp.renameTo(file)) {
        file.writeText(value)
        tmp.delete()
      }
      null
    }

  override fun storageDelete(key: String, promise: Promise) =
    storage(key, promise) { file ->
      file.delete()
      null
    }

  private fun storage(key: String, promise: Promise, op: (File) -> String?) {
    if (!KEY_PATTERN.matches(key)) {
      promise.reject("invalid_key", "Storage keys must match $KEY_PATTERN")
      return
    }
    try {
      io.execute {
        try {
          val dir = File(reactApplicationContext.noBackupFilesDir, "lander_react_native").apply { mkdirs() }
          promise.resolve(op(File(dir, key)))
        } catch (e: Exception) {
          promise.reject("storage_error", e.message ?: "Storage failed", e)
        }
      }
    } catch (e: RejectedExecutionException) {
      // The React instance is shutting down.
      promise.reject("storage_error", "Module invalidated", e)
    }
  }

  companion object {
    const val NAME = NativeRNLanderSpec.NAME
    const val LINK_EVENT = "LanderLink"
    private const val TAG = "Lander"
    private val KEY_PATTERN = Regex("^[a-z0-9_]{1,64}$")
  }
}
