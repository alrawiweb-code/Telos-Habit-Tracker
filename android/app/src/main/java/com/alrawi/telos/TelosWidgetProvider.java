package com.alrawi.telos;

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

public class TelosWidgetProvider extends AppWidgetProvider {

    public static final String ACTION_TOGGLE_HABIT = "com.alrawi.telos.ACTION_TOGGLE_HABIT";
    public static final String ACTION_REFRESH_WIDGET = "com.alrawi.telos.ACTION_REFRESH_WIDGET";

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            updateAppWidget(context, appWidgetManager, appWidgetId);
        }
    }

    static void updateAppWidget(Context context, AppWidgetManager appWidgetManager, int appWidgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_main);

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

        // Set up the intent that starts the WidgetService
        Intent intent = new Intent(context, WidgetService.class);
        intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        intent.setData(Uri.parse(intent.toUri(Intent.URI_INTENT_SCHEME) + "/" + appWidgetId));
        views.setRemoteAdapter(R.id.widget_list_view, intent);
        views.setEmptyView(R.id.widget_list_view, R.id.widget_empty_text);

        // Add Intention
        Intent addIntent = new Intent(context, MainActivity.class);
        addIntent.setAction(Intent.ACTION_VIEW);
        addIntent.setData(Uri.parse("telos://action?type=add_intention"));
        PendingIntent pendingAdd = PendingIntent.getActivity(context, 0, addIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.btn_add_intention, pendingAdd);

        // Add Journal
        Intent journalIntent = new Intent(context, MainActivity.class);
        journalIntent.setAction(Intent.ACTION_VIEW);
        journalIntent.setData(Uri.parse("telos://action?type=add_journal"));
        PendingIntent pendingJournal = PendingIntent.getActivity(context, 1, journalIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.btn_add_journal, pendingJournal);

        // Template for list item clicks
        Intent toggleIntent = new Intent(context, TelosWidgetProvider.class);
        toggleIntent.setAction(ACTION_TOGGLE_HABIT);
        toggleIntent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        PendingIntent pendingToggle = PendingIntent.getBroadcast(context, 0, toggleIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        views.setPendingIntentTemplate(R.id.widget_list_view, pendingToggle);

        appWidgetManager.updateAppWidget(appWidgetId, views);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);

        if (ACTION_TOGGLE_HABIT.equals(intent.getAction())) {
            String habitId = intent.getStringExtra("EXTRA_HABIT_ID");
            if (habitId != null) {
                // Toggle directly in SharedPreferences — NO app launch
                toggleHabitNatively(context, habitId);
                // Refresh ALL widgets so they stay in sync
                refreshAllWidgets(context);
            }
        } else if (ACTION_REFRESH_WIDGET.equals(intent.getAction()) || AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(intent.getAction())) {
            refreshAllWidgets(context);
        }
    }

    private void refreshAllWidgets(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);

        // --- Sync Light Widget (Big) ---
        ComponentName widgetLight = new ComponentName(context, TelosWidgetProvider.class);
        int[] idsLight = mgr.getAppWidgetIds(widgetLight);
        for (int id : idsLight) {
            updateAppWidget(context, mgr, id);
        }
        if (idsLight.length > 0) {
            mgr.notifyAppWidgetViewDataChanged(idsLight, R.id.widget_list_view);
        }

        // --- Sync Dark Widget (Big) ---
        try {
            ComponentName widgetDark = new ComponentName(context, TelosWidgetProviderDark.class);
            int[] idsDark = mgr.getAppWidgetIds(widgetDark);
            for (int id : idsDark) {
                TelosWidgetProviderDark.updateAppWidget(context, mgr, id);
            }
            if (idsDark.length > 0) {
                mgr.notifyAppWidgetViewDataChanged(idsDark, R.id.widget_list_view);
            }
        } catch (Exception e) {}

        // --- Sync Light Widget (Standard) ---
        try {
            ComponentName widgetLightStd = new ComponentName(context, TelosWidgetProviderStandard.class);
            int[] idsLightStd = mgr.getAppWidgetIds(widgetLightStd);
            for (int id : idsLightStd) {
                TelosWidgetProviderStandard.updateAppWidget(context, mgr, id);
            }
            if (idsLightStd.length > 0) {
                mgr.notifyAppWidgetViewDataChanged(idsLightStd, R.id.widget_list_view);
            }
        } catch (Exception e) {}

        // --- Sync Dark Widget (Standard) ---
        try {
            ComponentName widgetDarkStd = new ComponentName(context, TelosWidgetProviderDarkStandard.class);
            int[] idsDarkStd = mgr.getAppWidgetIds(widgetDarkStd);
            for (int id : idsDarkStd) {
                TelosWidgetProviderDarkStandard.updateAppWidget(context, mgr, id);
            }
            if (idsDarkStd.length > 0) {
                mgr.notifyAppWidgetViewDataChanged(idsDarkStd, R.id.widget_list_view);
            }
        } catch (Exception e) {}
    }

    /**
     * Toggles a habit's completed state directly in the widget_data JSON
     * stored in CapacitorStorage SharedPreferences.
     * Also queues the toggle in widget_pending_toggles so the app can
     * sync its own localStorage on next launch.
     */
    private static void toggleHabitNatively(Context context, String habitId) {
        SharedPreferences prefs = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        String widgetData = prefs.getString("widget_data", "[]");

        try {
            JSONArray arr = new JSONArray(widgetData);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.getJSONObject(i);
                if (habitId.equals(obj.optString("id"))) {
                    // Flip completed state
                    boolean wasCompleted = obj.optBoolean("completed");
                    obj.put("completed", !wasCompleted);
                    break;
                }
            }
            // Write updated widget_data back
            prefs.edit().putString("widget_data", arr.toString()).commit();

            // Queue this toggle so the app can sync on next open
            String pendingRaw = prefs.getString("widget_pending_toggles", "[]");
            JSONArray pending = new JSONArray(pendingRaw);
            JSONObject toggle = new JSONObject();
            toggle.put("id", habitId);
            toggle.put("ts", System.currentTimeMillis());
            pending.put(toggle);
            prefs.edit().putString("widget_pending_toggles", pending.toString()).commit();

        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}
