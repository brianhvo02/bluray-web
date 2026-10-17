package bdjweb.mixed;

import javax.tv.service.Service;
import javax.tv.service.SIManager;
import javax.tv.service.navigation.ServiceIterator;
import javax.tv.service.navigation.ServiceList;
import javax.tv.service.selection.ServiceContextFactory;
import javax.tv.xlet.Xlet;
import javax.tv.xlet.XletContext;

import org.bluray.ti.TitleImpl;
import org.bluray.ti.selection.TitleContext;

/*
 * First-play xlet of the synthetic HDMV and BD-J disc (disc-bdj-mixed): starts title 1, an HDMV title, through its
 * TitleContext. libbluray's BDJLoader hands an HDMV title to Libbluray.selectHdmvTitle, which calls selectTitleN; the
 * HDMV movie object then plays playlist 00000 and jumps to title 2, a BD-J title running PlaylistXlet.
 *
 * Compiled with -source 1.3 -target 1.3 (class version 47, as on real discs); no generics.
 */
public class HdmvTitleXlet implements Xlet {
    private XletContext context;

    public void initXlet(XletContext ctx) {
        context = ctx;
    }

    public void startXlet() {
        System.out.println("HdmvTitleXlet: start");
        try {
            TitleContext titleContext = (TitleContext) ServiceContextFactory.getInstance().getServiceContext(context);
            ServiceList services = SIManager.createInstance().filterServices(null);
            ServiceIterator it = services.createServiceIterator();
            while (it.hasNext()) {
                Service service = it.nextService();
                if (service instanceof TitleImpl && ((TitleImpl) service).getTitleNum() == 1) {
                    titleContext.start((org.bluray.ti.Title) service, true);
                    break;
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public void pauseXlet() {
    }

    public void destroyXlet(boolean unconditional) {
    }
}
