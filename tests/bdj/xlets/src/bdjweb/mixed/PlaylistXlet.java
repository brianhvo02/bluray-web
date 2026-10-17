package bdjweb.mixed;

import javax.media.Manager;
import javax.media.MediaLocator;
import javax.media.Player;
import javax.tv.xlet.Xlet;
import javax.tv.xlet.XletContext;

/*
 * Title 2 of the synthetic HDMV and BD-J disc (disc-bdj-mixed), the BD-J title that HDMV title 1 jumps to: creates a
 * JMF player for playlist 00001 and starts it, which makes libbluray call selectPlaylistN. Compiled with -source 1.3
 * -target 1.3 (class version 47); no generics.
 */
public class PlaylistXlet implements Xlet {
    private Player player;

    public void initXlet(XletContext ctx) {
    }

    public void startXlet() {
        System.out.println("PlaylistXlet: start");
        try {
            player = Manager.createPlayer(new MediaLocator("bd://PLAYLIST:00001"));
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
