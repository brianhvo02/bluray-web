package bdjweb.store;

import java.awt.Color;
import java.awt.Font;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;

import javax.media.Manager;
import javax.media.MediaLocator;
import javax.media.Player;
import javax.tv.xlet.Xlet;
import javax.tv.xlet.XletContext;

import org.havi.ui.HDefaultTextLayoutManager;
import org.havi.ui.HScene;
import org.havi.ui.HSceneFactory;
import org.havi.ui.HStaticText;
import org.havi.ui.HVisible;

/*
 * Title xlet of the synthetic saved-data disc (disc-bdj-store). It counts its own openings, as discs keep a resume point
 * or a "seen the intro" flag:
 * - reads its count from /persistent/<org>/<app>/count, the directory libbluray's BDJAppProxy.createStorage makes for
 *   it (the path built the same way: the dvb.persistent.root property, then the xlet properties dvb.org.id and
 *   dvb.app.id), 0 when the file is missing;
 * - counts the lines of the organisation's loose BUDA file, bluray.bindingunit.root/<org>/x.log (outside any disc
 *   folder), 0 when it is missing;
 * - draws both numbers in the plane ("count <c>  log <l>"), then writes c + 1 back to count (FileWriter) and appends a
 *   line to x.log;
 * - only then plays playlist 00000, which tells a test the write has happened.
 * So the first opening shows "count 0  log 0", the next "count 1  log 1", and so on. Compiled with -source 1.3
 * -target 1.3 (class version 47); no generics.
 */
public class StoreXlet implements Xlet {
    private XletContext context;
    private HScene scene;
    private Player player;

    public void initXlet(XletContext ctx) {
        context = ctx;
    }

    public void startXlet() {
        String org = (String)context.getXletProperty("dvb.org.id");
        String app = (String)context.getXletProperty("dvb.app.id");
        String appDir = System.getProperty("dvb.persistent.root") + File.separator + org + File.separator + app;
        File count = new File(appDir, "count");
        File log = new File(System.getProperty("bluray.bindingunit.root") + File.separator + org, "x.log");
        System.out.println("StoreXlet: start, " + count.getPath());

        int c = readCount(count);
        int l = countLines(log);
        System.out.println("StoreXlet: count " + c + ", log " + l);
        show("count " + c + "  log " + l);

        try {
            FileWriter w = new FileWriter(count);
            w.write(Integer.toString(c + 1));
            w.close();
            FileWriter a = new FileWriter(log.getPath(), true);
            a.write("opened\n");
            a.close();
            System.out.println("StoreXlet: wrote " + (c + 1));
        } catch (IOException e) {
            System.out.println("StoreXlet: write failed: " + e);
        }

        try {
            player = Manager.createPlayer(new MediaLocator("bd://PLAYLIST:00000"));
            player.start();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private static int readCount(File f) {
        if (!f.exists()) {
            return 0;
        }
        try {
            FileInputStream in = new FileInputStream(f);
            byte[] buf = new byte[32];
            int n = 0;
            int r;
            while (n < buf.length && (r = in.read(buf, n, buf.length - n)) > 0) {
                n += r;
            }
            in.close();
            return Integer.parseInt(new String(buf, 0, n, "US-ASCII").trim());
        } catch (Exception e) {
            System.out.println("StoreXlet: read failed: " + e);
            return -1;
        }
    }

    private static int countLines(File f) {
        if (!f.exists()) {
            return 0;
        }
        int n = 0;
        try {
            BufferedReader r = new BufferedReader(new FileReader(f));
            while (r.readLine() != null) {
                n++;
            }
            r.close();
        } catch (IOException e) {
            System.out.println("StoreXlet: log read failed: " + e);
            return -1;
        }
        return n;
    }

    /** The text in the fallback font at 36 px, a size whose glyphs freetype.wasm renders as the harness does (its golden's largest). */
    private void show(String text) {
        scene = HSceneFactory.getInstance().getDefaultHScene();
        scene.setVisible(false);
        scene.setLayout(null);
        scene.setBounds(0, 0, 1920, 1080);
        HStaticText label = new HStaticText(text, 160, 160, 640, 100, new Font("SansSerif", Font.PLAIN, 36),
            Color.white, new Color(0x20, 0x40, 0x90, 0xc0), new HDefaultTextLayoutManager());
        label.setBackgroundMode(HVisible.BACKGROUND_FILL);
        scene.add(label);
        scene.validate();
        scene.setVisible(true);
        scene.repaint();
    }

    public void pauseXlet() {
    }

    public void destroyXlet(boolean unconditional) {
    }
}
