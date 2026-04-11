package telos.app;

import android.content.Intent;
import android.widget.RemoteViewsService;

public class WidgetServiceDarkStandard extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new WidgetViewsFactoryDarkStandard(this.getApplicationContext(), intent);
    }
}
