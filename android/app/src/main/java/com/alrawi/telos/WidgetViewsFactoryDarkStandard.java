package com.alrawi.telos;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public class WidgetViewsFactoryDarkStandard implements RemoteViewsService.RemoteViewsFactory {
    private Context context;
    private List<HabitItem> habitList = new ArrayList<>();

    // Telos dark color palette
    private static final int COLOR_TEXT_PRIMARY   = Color.parseColor("#F1F1F1");
    private static final int COLOR_TEXT_SECONDARY  = Color.parseColor("#A1A1A1");
    private static final int COLOR_SAGE           = Color.parseColor("#9AB297");

    public WidgetViewsFactoryDarkStandard(Context context, Intent intent) {
        this.context = context;
    }

    @Override
    public void onCreate() {}

    @Override
    public void onDataSetChanged() {
        SharedPreferences prefs = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        String widgetData = prefs.getString("widget_data", "[]");
        habitList.clear();
        try {
            JSONArray arr = new JSONArray(widgetData);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.getJSONObject(i);
                HabitItem item = new HabitItem();
                item.id = obj.optString("id");
                item.name = obj.optString("name");
                item.icon = obj.optString("icon");
                item.completed = obj.optBoolean("completed");
                habitList.add(item);
            }
        } catch (Exception e) {}
    }

    @Override
    public void onDestroy() {
        habitList.clear();
    }

    @Override
    public int getCount() {
        return habitList.size();
    }

    @Override
    public RemoteViews getViewAt(int position) {
        if (position >= habitList.size()) return null;
        HabitItem item = habitList.get(position);

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_item_dark_standard);

        views.setTextViewText(R.id.widget_item_text, item.name);
        String letter = item.name != null && item.name.length() > 0 ? item.name.substring(0, 1).toUpperCase() : "?";
        views.setTextViewText(R.id.widget_item_icon_letter, letter);

        if (item.completed) {
            views.setImageViewResource(R.id.widget_item_icon_bg, R.drawable.widget_icon_bg_done_dark);
            views.setInt(R.id.widget_item_root, "setBackgroundResource", R.drawable.widget_item_bg_done_dark);
            views.setTextColor(R.id.widget_item_text, COLOR_TEXT_SECONDARY);
            views.setTextColor(R.id.widget_item_icon_letter, COLOR_SAGE);
            views.setImageViewResource(R.id.widget_item_check_bg, R.drawable.widget_circle_checked_dark);
            views.setViewVisibility(R.id.widget_item_check_mark, View.VISIBLE);
        } else {
            views.setImageViewResource(R.id.widget_item_icon_bg, R.drawable.widget_icon_bg_dark);
            views.setInt(R.id.widget_item_root, "setBackgroundResource", R.drawable.widget_item_bg_dark);
            views.setTextColor(R.id.widget_item_text, COLOR_TEXT_PRIMARY);
            views.setTextColor(R.id.widget_item_icon_letter, COLOR_TEXT_PRIMARY);
            views.setImageViewResource(R.id.widget_item_check_bg, R.drawable.widget_circle_empty_dark);
            views.setViewVisibility(R.id.widget_item_check_mark, View.GONE);
        }

        Intent fillInIntent = new Intent();
        fillInIntent.putExtra("EXTRA_HABIT_ID", item.id);
        fillInIntent.putExtra("EXTRA_COMPLETED", item.completed);
        views.setOnClickFillInIntent(R.id.widget_item_root, fillInIntent);

        return views;
    }

    @Override public RemoteViews getLoadingView() { return null; }
    @Override public int getViewTypeCount() { return 1; }
    @Override public long getItemId(int position) { return position; }
    @Override public boolean hasStableIds() { return true; }

    static class HabitItem {
        String id;
        String name;
        String icon;
        boolean completed;
    }
}
