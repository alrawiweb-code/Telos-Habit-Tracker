package telos.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.widget.RemoteViews;
import android.content.ComponentName;

import org.json.JSONArray;
import org.json.JSONObject;

public class TelosWidgetProviderStandard extends AppWidgetProvider {

    public static final String ACTION_TOGGLE_HABIT_STANDARD = "telos.app.ACTION_TOGGLE_HABIT_STANDARD";
    public static final String ACTION_REFRESH_WIDGET = "telos.app.ACTION_REFRESH_WIDGET";

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            updateAppWidget(context, appWidgetManager, appWidgetId);
        }
    }

    static void updateAppWidget(Context context, AppWidgetManager appWidgetManager, int appWidgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_main_standard);

        // Calculate progress from CapacitorStorage
        SharedPreferences prefs = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        String widgetData = prefs.getString("widget_data", "[]");
        int total = 0;
        int completed = 0;
        try {
            JSONArray arr = new JSONArray(widgetData);
            total = arr.length();
            for (int i=0; i<total; i++) {
                if (arr.getJSONObject(i).optBoolean("completed")) {
                    completed++;
                }
            }
        } catch(Exception e) {}

        // Set progress
        views.setTextViewText(R.id.widget_progress_text, completed + "/" + total);
        views.setProgressBar(R.id.widget_progress_bar, total == 0 ? 1 : total, completed, false);
        
        // Update subtitle
        if (total == 0) {
            views.setTextViewText(R.id.widget_subtitle, "A clear slate awaits.");
        } else if (completed == total) {
            views.setTextViewText(R.id.widget_subtitle, "All done. Well earned. ✦");
        } else if (completed == 0) {
            views.setTextViewText(R.id.widget_subtitle, total + " intentions waiting.");
        } else {
            views.setTextViewText(R.id.widget_subtitle, completed + " of " + total + " complete.");
        }

        // Set up the intent that starts the WidgetServiceStandard
        Intent intent = new Intent(context, WidgetServiceStandard.class);
        intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        intent.setData(Uri.parse(intent.toUri(Intent.URI_INTENT_SCHEME) + "/" + appWidgetId));
        views.setRemoteAdapter(R.id.widget_list_view, intent);
        views.setEmptyView(R.id.widget_list_view, R.id.widget_empty_text);

        // Add Intention
        Intent addIntent = new Intent(context, MainActivity.class);
        addIntent.setAction(Intent.ACTION_VIEW);
        addIntent.setData(Uri.parse("telos://action?type=add_intention"));
        PendingIntent pendingAdd = PendingIntent.getActivity(context, 4, addIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.btn_add_intention, pendingAdd);

        // Add Journal
        Intent journalIntent = new Intent(context, MainActivity.class);
        journalIntent.setAction(Intent.ACTION_VIEW);
        journalIntent.setData(Uri.parse("telos://action?type=add_journal"));
        PendingIntent pendingJournal = PendingIntent.getActivity(context, 5, journalIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.btn_add_journal, pendingJournal);

        // Template for list item clicks
        Intent toggleIntent = new Intent(context, TelosWidgetProviderStandard.class);
        toggleIntent.setAction(ACTION_TOGGLE_HABIT_STANDARD);
        toggleIntent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        PendingIntent pendingToggle = PendingIntent.getBroadcast(context, 4, toggleIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        views.setPendingIntentTemplate(R.id.widget_list_view, pendingToggle);

        appWidgetManager.updateAppWidget(appWidgetId, views);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);

        if (ACTION_TOGGLE_HABIT_STANDARD.equals(intent.getAction())) {
            String habitId = intent.getStringExtra("EXTRA_HABIT_ID");
            if (habitId != null) {
                toggleHabitNatively(context, habitId);
                refreshAllWidgets(context);
            }
        } else if (ACTION_REFRESH_WIDGET.equals(intent.getAction()) || AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(intent.getAction())) {
            refreshAllWidgets(context);
        }
    }

    private void refreshAllWidgets(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        
        // Refresh Light (Big)
        int[] idsLight = mgr.getAppWidgetIds(new ComponentName(context, TelosWidgetProvider.class));
        for (int id : idsLight) TelosWidgetProvider.updateAppWidget(context, mgr, id);
        if (idsLight.length > 0) mgr.notifyAppWidgetViewDataChanged(idsLight, R.id.widget_list_view);

        // Refresh Dark (Big)
        int[] idsDark = mgr.getAppWidgetIds(new ComponentName(context, TelosWidgetProviderDark.class));
        for (int id : idsDark) TelosWidgetProviderDark.updateAppWidget(context, mgr, id);
        if (idsDark.length > 0) mgr.notifyAppWidgetViewDataChanged(idsDark, R.id.widget_list_view);

        // Refresh Light (Standard)
        int[] idsLightStd = mgr.getAppWidgetIds(new ComponentName(context, TelosWidgetProviderStandard.class));
        for (int id : idsLightStd) TelosWidgetProviderStandard.updateAppWidget(context, mgr, id);
        if (idsLightStd.length > 0) mgr.notifyAppWidgetViewDataChanged(idsLightStd, R.id.widget_list_view);

        // Refresh Dark (Standard)
        int[] idsDarkStd = mgr.getAppWidgetIds(new ComponentName(context, TelosWidgetProviderDarkStandard.class));
        for (int id : idsDarkStd) TelosWidgetProviderDarkStandard.updateAppWidget(context, mgr, id);
        if (idsDarkStd.length > 0) mgr.notifyAppWidgetViewDataChanged(idsDarkStd, R.id.widget_list_view);
    }

    private static void toggleHabitNatively(Context context, String habitId) {
        SharedPreferences prefs = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        String widgetData = prefs.getString("widget_data", "[]");
        try {
            JSONArray arr = new JSONArray(widgetData);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.getJSONObject(i);
                if (habitId.equals(obj.optString("id"))) {
                    obj.put("completed", !obj.optBoolean("completed"));
                    break;
                }
            }
            prefs.edit().putString("widget_data", arr.toString()).commit();
            
            // Sync with app
            String pendingRaw = prefs.getString("widget_pending_toggles", "[]");
            JSONArray pending = new JSONArray(pendingRaw);
            JSONObject toggle = new JSONObject();
            toggle.put("id", habitId);
            toggle.put("ts", System.currentTimeMillis());
            pending.put(toggle);
            prefs.edit().putString("widget_pending_toggles", pending.toString()).commit();
        } catch (Exception e) {}
    }
}
