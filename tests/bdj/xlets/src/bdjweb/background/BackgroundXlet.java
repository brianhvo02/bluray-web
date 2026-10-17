package bdjweb.background;

import javax.media.Manager;
import javax.media.MediaLocator;
import javax.media.Player;
import javax.tv.xlet.Xlet;
import javax.tv.xlet.XletContext;

import org.havi.ui.HBackgroundConfiguration;
import org.havi.ui.HBackgroundDevice;
import org.havi.ui.HBackgroundImage;
import org.havi.ui.HScreen;
import org.havi.ui.HScreenRectangle;
import org.havi.ui.HStillImageBackgroundConfiguration;
import org.havi.ui.event.HBackgroundImageEvent;
import org.havi.ui.event.HBackgroundImageListener;

/*
 * Title xlet of the synthetic background disc (disc-bdj-background): loads bg.png from its own jar as a HAVi background
 * image, as discs load theirs (new HBackgroundImage(String) relative to the xlet's home, then load()), shows it with
 * HStillImageBackgroundConfiguration.displayImage in the left half of the screen, and then plays playlist 00000 over
 * it. Compiled with -source 1.3 -target 1.3 (class version 47); no generics.
 */
public class BackgroundXlet implements Xlet, HBackgroundImageListener {
    private HStillImageBackgroundConfiguration config;
    private HBackgroundImage image;
    private Player player;
    /** 0 while loading, 1 loaded, 2 failed. */
    private int result;

    public void initXlet(XletContext ctx) {
    }

    public void startXlet() {
        System.out.println("BackgroundXlet: start");
        HBackgroundDevice device = HScreen.getDefaultHScreen().getDefaultHBackgroundDevice();
        HBackgroundConfiguration current = device.getCurrentConfiguration();
        if (!(current instanceof HStillImageBackgroundConfiguration)) {
            System.out.println("BackgroundXlet: no still image configuration");
            return;
        }
        config = (HStillImageBackgroundConfiguration)current;
        image = new HBackgroundImage("bg.png");
        // the listener runs on the image fetcher's thread, which may not create players: wait for it here
        synchronized (this) {
            image.load(this);
            long end = System.currentTimeMillis() + 10000;
            while (result == 0 && System.currentTimeMillis() < end) {
                try {
                    wait(end - System.currentTimeMillis());
                } catch (InterruptedException e) {
                    return;
                }
            }
        }
        if (result != 1) {
            System.out.println("BackgroundXlet: load failed");
            return;
        }
        System.out.println("BackgroundXlet: loaded " + image.getWidth() + "x" + image.getHeight());
        try {
            config.displayImage(image, new HScreenRectangle(0.0f, 0.0f, 0.5f, 1.0f));
            player = Manager.createPlayer(new MediaLocator("bd://PLAYLIST:00000"));
            player.start();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public synchronized void imageLoaded(HBackgroundImageEvent event) {
        result = 1;
        notifyAll();
    }

    public synchronized void imageLoadFailed(HBackgroundImageEvent event) {
        result = 2;
        notifyAll();
    }

    public void pauseXlet() {
    }

    public void destroyXlet(boolean unconditional) {
    }
}
