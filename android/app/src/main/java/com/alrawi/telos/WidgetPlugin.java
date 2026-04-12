package com.alrawi.telos;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import android.content.Context;





@CapacitorPlugin(name = "WidgetPlugin")
public class WidgetPlugin extends Plugin {

    @PluginMethod
    public void update(PluginCall call) {
        Context context = getContext();
        String data = call.getString("data");

        if (data != null) {
            try {
                // Synchronously COMMIT to disk so the widget sees the new data IMMEDIATELY
                context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
                        .edit()
                        .putString("widget_data", data)
                        .commit();
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        // Directly push updated RemoteViews on the main thread — this bypasses the
        // async broadcast queue and guarantees the widget list refreshes instantly.
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                AppWidgetManager mgr = AppWidgetManager.getInstance(context);

                // Light (Big)
                int[] idsLight = mgr.getAppWidgetIds(new ComponentName(context, TelosWidgetProvider.class));
                for (int id : idsLight) TelosWidgetProvider.updateAppWidget(context, mgr, id);
                if (idsLight.length > 0) mgr.notifyAppWidgetViewDataChanged(idsLight, R.id.widget_list_view);

                // Dark (Big)
                int[] idsDark = mgr.getAppWidgetIds(new ComponentName(context, TelosWidgetProviderDark.class));
                for (int id : idsDark) TelosWidgetProviderDark.updateAppWidget(context, mgr, id);
                if (idsDark.length > 0) mgr.notifyAppWidgetViewDataChanged(idsDark, R.id.widget_list_view);

                // Light (Standard)
                int[] idsLightStd = mgr.getAppWidgetIds(new ComponentName(context, TelosWidgetProviderStandard.class));
                for (int id : idsLightStd) TelosWidgetProviderStandard.updateAppWidget(context, mgr, id);
                if (idsLightStd.length > 0) mgr.notifyAppWidgetViewDataChanged(idsLightStd, R.id.widget_list_view);

                // Dark (Standard)
                int[] idsDarkStd = mgr.getAppWidgetIds(new ComponentName(context, TelosWidgetProviderDarkStandard.class));
                for (int id : idsDarkStd) TelosWidgetProviderDarkStandard.updateAppWidget(context, mgr, id);
                if (idsDarkStd.length > 0) mgr.notifyAppWidgetViewDataChanged(idsDarkStd, R.id.widget_list_view);

            } catch (Exception e) {
                e.printStackTrace();
            }
        });

        call.resolve();
    }
}
