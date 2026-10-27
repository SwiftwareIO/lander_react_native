package link.lander.reactnative

import android.app.Activity
import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import java.util.WeakHashMap

/**
 * Remembers which activities already had their launch link delivered.
 *
 * After process death Android recreates the activity with its original VIEW
 * intent, so without this the old link would navigate again. The flag travels
 * in the activity's saved state, which is why tracking has to start before the
 * first activity is created (see [LanderInitProvider]). The same flag covers an
 * activity recreated for a configuration change.
 */
internal object LaunchTracker : Application.ActivityLifecycleCallbacks {
  private const val HANDLED = "link.lander.reactnative.launch_link_handled"

  private val handled = WeakHashMap<Activity, Boolean>()
  @Volatile private var registered = false

  fun register(application: Application) {
    if (registered) return
    synchronized(this) {
      if (registered) return
      registered = true
      application.registerActivityLifecycleCallbacks(this)
    }
  }

  fun isHandled(activity: Activity): Boolean = synchronized(handled) { handled[activity] == true }

  fun markHandled(activity: Activity) {
    synchronized(handled) { handled[activity] = true }
  }

  override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
    if (savedInstanceState?.getBoolean(HANDLED) == true) markHandled(activity)
  }

  override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {
    if (isHandled(activity)) outState.putBoolean(HANDLED, true)
  }

  override fun onActivityStarted(activity: Activity) = Unit

  override fun onActivityResumed(activity: Activity) = Unit

  override fun onActivityPaused(activity: Activity) = Unit

  override fun onActivityStopped(activity: Activity) = Unit

  override fun onActivityDestroyed(activity: Activity) = Unit
}

/** Registers [LaunchTracker] when the app process starts. Serves no data. */
class LanderInitProvider : ContentProvider() {
  override fun onCreate(): Boolean {
    (context?.applicationContext as? Application)?.let(LaunchTracker::register)
    return true
  }

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor? = null

  override fun getType(uri: Uri): String? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = 0
}
