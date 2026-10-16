package bdjweb.test;

import javax.tv.service.Service;
import javax.tv.service.SIManager;
import javax.tv.service.navigation.ServiceIterator;
import javax.tv.service.navigation.ServiceList;
import javax.tv.service.selection.ServiceContextFactory;
import javax.tv.xlet.Xlet;
import javax.tv.xlet.XletContext;

import org.bluray.system.RegisterAccess;
import org.bluray.ti.TitleImpl;
import org.bluray.ti.selection.TitleContext;
import org.bluray.ui.event.HRcEvent;
import org.dvb.event.EventManager;
import org.dvb.event.UserEvent;
import org.dvb.event.UserEventListener;
import org.dvb.event.UserEventRepository;

/*
 * First-play xlet of the synthetic BD-J disc (disc-bdj). Its startXlet exercises, in order: two PSR reads (diagnostic),
 * GPR 100 = 42 (writeRegN), a user-event repository for ENTER and UP (EventManager), and a TitleContext start of
 * title 1, a BD-J title running TitleXlet (a BD-J to BD-J change stays inside Java: no selectTitleN).
 *
 * Compiled with -source 1.3 -target 1.3 (class version 47, as on real discs); no generics.
 *
 * Deviations from the plan's API list, because libbluray's own Java code decides which native each API reaches:
 *  - setKeyInterestN is not reached through EventManager. libbluray calls it from BDJLoader.loadN with the BDJO's key
 *    interest table whenever a BD-J title loads, so the BDJO's keyInterest field is what produces it (the EventManager
 *    registration is kept as the public-API step).
 *  - selectTitleN is only reached for HDMV titles (BDJLoader to Libbluray.selectHdmvTitle), so this disc does not
 *    exercise it.
 *  - Titles are found through SIManager's service list; TitleImpl.getTitleNum is libbluray's own class.
 */
public class FirstPlayXlet implements Xlet, UserEventListener {
    private XletContext context;

    public void initXlet(XletContext ctx) {
        context = ctx;
    }

    public void startXlet() {
        System.out.println("FirstPlayXlet: start");
        try {
            RegisterAccess regs = RegisterAccess.getInstance();
            regs.getPSR(4);
            regs.getPSR(20);
            regs.setGPR(100, 42);

            UserEventRepository repository = new UserEventRepository("keys");
            repository.addKey(HRcEvent.VK_ENTER);
            repository.addKey(HRcEvent.VK_UP);
            EventManager.getInstance().addUserEventListener(this, repository);

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

    public void userEventReceived(UserEvent e) {
    }
}
