package com.alrawi.telos;

import android.content.Intent;
import android.widget.RemoteViewsService;

public class WidgetServiceDark extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new WidgetViewsFactoryDark(this.getApplicationContext(), intent);
    }
}
