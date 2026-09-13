package cloud.venueprocrm.signage;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** Best effort for older devices; default HOME handles modern Android startup. */
public class BootReceiver extends BroadcastReceiver {
 @Override public void onReceive(Context context, Intent intent) {
  String action=intent.getAction();
  if(!Intent.ACTION_BOOT_COMPLETED.equals(action)&&!Intent.ACTION_MY_PACKAGE_REPLACED.equals(action))return;
  try { context.startActivity(new Intent(context,MainActivity.class)
    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP)); }
  catch(RuntimeException error){Log.w("VenuePro","Select VenuePro as the default Home app for automatic startup",error);}
 }
}
