package telos.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public class WidgetViewsFactory implements RemoteViewsService.RemoteViewsFactory {
    private Context context;
    private List<HabitItem> habitList = new ArrayList<>();

    // Telos color palette
    private static final int COLOR_TEXT_PRIMARY   = Color.parseColor("#2A2A2A");
    private static final int COLOR_TEXT_SECONDARY  = Color.parseColor("#5C5C5C");
    private static final int COLOR_SAGE           = Color.parseColor("#637260");
    private static final int COLOR_CHECK_TEXT     = Color.parseColor("#121212");

    public WidgetViewsFactory(Context context, Intent intent) {
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
        } catch (Exception e) {
            e.printStackTrace();
        }
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

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_item);

        // Task name
        views.setTextViewText(R.id.widget_item_text, item.name);

        // First letter avatar
        String letter = item.name != null && item.name.length() > 0
                ? item.name.substring(0, 1).toUpperCase() : "?";
        views.setTextViewText(R.id.widget_item_icon_letter, letter);

        if (item.completed) {
            // Completed: green pill bg, green icon circle, show checkmark
            views.setImageViewResource(R.id.widget_item_icon_bg, R.drawable.widget_icon_bg_done);
            views.setInt(R.id.widget_item_root, "setBackgroundResource", R.drawable.widget_item_bg_done);
            views.setTextColor(R.id.widget_item_text, COLOR_TEXT_SECONDARY);
            views.setTextColor(R.id.widget_item_icon_letter, COLOR_SAGE);

            // Show filled check circle + checkmark
            views.setImageViewResource(R.id.widget_item_check_bg, R.drawable.widget_circle_checked);
            views.setViewVisibility(R.id.widget_item_check_mark, View.VISIBLE);
        } else {
            // Incomplete: default pill bg, default icon circle, hide checkmark
            views.setImageViewResource(R.id.widget_item_icon_bg, R.drawable.widget_icon_bg);
            views.setInt(R.id.widget_item_root, "setBackgroundResource", R.drawable.widget_item_bg);
            views.setTextColor(R.id.widget_item_text, COLOR_TEXT_PRIMARY);
            views.setTextColor(R.id.widget_item_icon_letter, COLOR_TEXT_PRIMARY);

            // Show empty circle, hide checkmark
            views.setImageViewResource(R.id.widget_item_check_bg, R.drawable.widget_circle_empty);
            views.setViewVisibility(R.id.widget_item_check_mark, View.GONE);
        }

        // Click intent
        Intent fillInIntent = new Intent();
        fillInIntent.putExtra("EXTRA_HABIT_ID", item.id);
        fillInIntent.putExtra("EXTRA_COMPLETED", item.completed);
        views.setOnClickFillInIntent(R.id.widget_item_root, fillInIntent);

        return views;
    }

    @Override
    public RemoteViews getLoadingView() {
        return null;
    }

    @Override
    public int getViewTypeCount() {
        return 1;
    }

    @Override
    public long getItemId(int position) {
        return position;
    }

    @Override
    public boolean hasStableIds() {
        return true;
    }

    static class HabitItem {
        String id;
        String name;
        String icon;
        boolean completed;
    }
}
