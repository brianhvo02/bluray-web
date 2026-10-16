package bdjweb.test;

import javax.media.Manager;
import javax.media.MediaLocator;
import javax.media.Player;
import javax.tv.xlet.Xlet;
import javax.tv.xlet.XletContext;

/*
 * Title xlet of the synthetic BD-J disc (disc-bdj): creates a JMF player for playlist 00000 and starts it, which makes
 * libbluray call selectPlaylistN. Compiled with -source 1.3 -target 1.3 (class version 47); no generics.
 */
public class TitleXlet implements Xlet {
    private Player player;

    public void initXlet(XletContext ctx) {
    }

    public void startXlet() {
        System.out.println("TitleXlet: start");
        try {
            player = Manager.createPlayer(new MediaLocator("bd://PLAYLIST:00000"));
            player.start();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public void pauseXlet() {
    }

    public void destroyXlet(boolean unconditional) {
    }
}
