package bdjweb.menu;

import java.awt.Color;
import java.awt.Font;
import java.awt.Image;
import java.awt.MediaTracker;
import java.awt.Rectangle;
import java.awt.Toolkit;
import java.awt.event.ActionEvent;
import java.awt.event.MouseEvent;
import java.awt.event.MouseListener;

import javax.media.ControllerEvent;
import javax.media.ControllerListener;
import javax.media.Manager;
import javax.media.MediaLocator;
import javax.media.Player;
import javax.media.StartEvent;
import javax.tv.xlet.Xlet;
import javax.tv.xlet.XletContext;

import org.dvb.ui.FontFactory;
import org.havi.ui.HBackgroundConfiguration;
import org.havi.ui.HBackgroundDevice;
import org.havi.ui.HBackgroundImage;
import org.havi.ui.HDefaultTextLayoutManager;
import org.havi.ui.HScene;
import org.havi.ui.HSceneFactory;
import org.havi.ui.HScreen;
import org.havi.ui.HScreenRectangle;
import org.havi.ui.HState;
import org.havi.ui.HStaticIcon;
import org.havi.ui.HStillImageBackgroundConfiguration;
import org.havi.ui.HTextButton;
import org.havi.ui.HVisible;
import org.havi.ui.event.HActionEvent;
import org.havi.ui.event.HActionListener;
import org.havi.ui.event.HBackgroundImageEvent;
import org.havi.ui.event.HBackgroundImageListener;

/*
 * Title xlet of the synthetic BD-J menu disc (disc-bdj-menu). It plays playlist 00001 behind its menu, as discs play a
 * menu background, then shows an HScene with a PNG logo (logo.png, an HStaticIcon) and three HTextButtons: Play and
 * Extras in the disc's font (BDMV/AUXDATA/00000.otf, named SourceSans3 in dvb.fontindex, read through FontFactory) and
 * Chapters in the fallback font (SansSerif). Up and down move the focus (HAVi focus traversal, the focused button gets
 * its border); Enter on Play hides the menu and plays playlist 00000. Play has a MouseListener: a click inside its
 * bounds changes its text (libbluray posts mouse events to the focus owner, with plane coordinates), a click elsewhere
 * changes nothing. Under the menu it shows a background still (bg.png) with HStillImageBackgroundConfiguration. Nothing
 * animates, so every flush follows from the start-up or from an input. Compiled with -source 1.3 -target 1.3 (class
 * version 47); no generics.
 */
public class MenuXlet implements Xlet, HActionListener, HBackgroundImageListener, ControllerListener, MouseListener {
    /** Where the buttons are, in the 1920x1080 plane (the scene covers the whole plane). */
    static final int BUTTON_X = 160;
    static final int BUTTON_Y = 360;
    static final int BUTTON_W = 520;
    static final int BUTTON_H = 100;
    static final int BUTTON_GAP = 130;

    private HScene scene;
    private HTextButton play;
    private Player player;
    private boolean started;
    private int clicks;
    /** 0 while the still loads, 1 loaded, 2 failed. */
    private int stillResult;

    public void initXlet(XletContext ctx) {
    }

    public void startXlet() {
        System.out.println("MenuXlet: start");
        playBackground();
        showStill();
        showMenu();
    }

    /** Plays playlist 00001 behind the menu and waits until it has started, so the menu's flushes come after it. */
    private void playBackground() {
        try {
            player = Manager.createPlayer(new MediaLocator("bd://PLAYLIST:00001"));
            player.addControllerListener(this);
            synchronized (this) {
                player.start();
                long end = System.currentTimeMillis() + 10000;
                while (!started && System.currentTimeMillis() < end) {
                    wait(end - System.currentTimeMillis());
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public void controllerUpdate(ControllerEvent event) {
        if (event instanceof StartEvent) {
            synchronized (this) {
                started = true;
                notifyAll();
            }
        }
    }

    /** bg.png from the xlet's jar, in the right half of the screen. */
    private void showStill() {
        HBackgroundDevice device = HScreen.getDefaultHScreen().getDefaultHBackgroundDevice();
        HBackgroundConfiguration current = device.getCurrentConfiguration();
        if (!(current instanceof HStillImageBackgroundConfiguration)) {
            System.out.println("MenuXlet: no still image configuration");
            return;
        }
        HBackgroundImage still = new HBackgroundImage("bg.png");
        synchronized (this) {
            still.load(this);
            long end = System.currentTimeMillis() + 10000;
            while (stillResult == 0 && System.currentTimeMillis() < end) {
                try {
                    wait(end - System.currentTimeMillis());
                } catch (InterruptedException e) {
                    return;
                }
            }
        }
        if (stillResult != 1) {
            System.out.println("MenuXlet: still failed");
            return;
        }
        try {
            ((HStillImageBackgroundConfiguration)current).displayImage(still, new HScreenRectangle(0.5f, 0.0f, 0.5f, 1.0f));
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public synchronized void imageLoaded(HBackgroundImageEvent event) {
        stillResult = 1;
        notifyAll();
    }

    public synchronized void imageLoadFailed(HBackgroundImageEvent event) {
        stillResult = 2;
        notifyAll();
    }

    private void showMenu() {
        Font fallback = new Font("SansSerif", Font.PLAIN, 40);
        Font disc = fallback;
        try {
            disc = new FontFactory().createFont("SourceSans3", Font.PLAIN, 48);
        } catch (Exception e) {
            System.out.println("MenuXlet: no disc font: " + e);
        }

        scene = HSceneFactory.getInstance().getDefaultHScene();
        // a new scene is visible already (an AWT container); hidden while it is built, so showing it shows the root window
        scene.setVisible(false);
        scene.setLayout(null);
        scene.setBounds(0, 0, 1920, 1080);

        Image logo = Toolkit.getDefaultToolkit().createImage("logo.png");
        MediaTracker tracker = new MediaTracker(scene);
        tracker.addImage(logo, 0);
        try {
            tracker.waitForAll(10000);
        } catch (InterruptedException e) {
            return;
        }
        HStaticIcon icon = new HStaticIcon(logo, BUTTON_X, 160, 240, 72);
        scene.add(icon);

        play = button("Play", disc, 0);
        HTextButton chapters = button("Chapters", fallback, 1);
        HTextButton extras = button("Extras", disc, 2);
        play.setFocusTraversal(null, chapters, null, null);
        chapters.setFocusTraversal(play, extras, null, null);
        extras.setFocusTraversal(chapters, null, null, null);
        play.setActionCommand("play");
        play.addHActionListener(this);
        play.addMouseListener(this);

        scene.validate();
        scene.setVisible(true);
        play.requestFocus();
        System.out.println("MenuXlet: menu shown");
    }

    private HTextButton button(String text, Font font, int index) {
        HTextButton b = new HTextButton(text, BUTTON_X, BUTTON_Y + index * BUTTON_GAP, BUTTON_W, BUTTON_H, font,
            Color.white, new Color(0x20, 0x40, 0x90, 0xc0), new HDefaultTextLayoutManager());
        b.setBackgroundMode(HVisible.BACKGROUND_FILL);
        b.setBordersEnabled(true);
        scene.add(b);
        return b;
    }

    public void actionPerformed(ActionEvent event) {
        if (!(event instanceof HActionEvent) || !"play".equals(event.getActionCommand())) {
            return;
        }
        System.out.println("MenuXlet: play");
        scene.setVisible(false);
        try {
            player.stop();
            player.close();
            player = Manager.createPlayer(new MediaLocator("bd://PLAYLIST:00000"));
            player.start();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public void mouseClicked(MouseEvent e) {
        Rectangle r = play.getBounds();
        if (!r.contains(e.getX(), e.getY())) {
            return;
        }
        clicks++;
        System.out.println("MenuXlet: clicked Play " + clicks);
        play.setTextContent("Play (" + clicks + ")", HState.ALL_STATES);
    }

    public void mousePressed(MouseEvent e) {
    }

    public void mouseReleased(MouseEvent e) {
    }

    public void mouseEntered(MouseEvent e) {
    }

    public void mouseExited(MouseEvent e) {
    }

    public void pauseXlet() {
    }

    public void destroyXlet(boolean unconditional) {
    }
}
