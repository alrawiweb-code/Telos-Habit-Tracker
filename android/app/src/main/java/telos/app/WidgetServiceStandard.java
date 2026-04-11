package telos.app;

import android.content.Intent;
import android.widget.RemoteViewsService;

public class WidgetServiceStandard extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new WidgetViewsFactoryStandard(this.getApplicationContext(), intent);
    }
}
