package bdjweb.test;

import javax.media.ControllerEvent;
import javax.media.ControllerListener;
import javax.media.EndOfMediaEvent;
import javax.media.Manager;
import javax.media.MediaLocator;
import javax.media.Player;
import javax.tv.xlet.Xlet;
import javax.tv.xlet.XletContext;

/*
 * Title xlet of the synthetic BD-J disc (disc-bdj): creates a JMF player for playlist 00000 and starts it, which makes
 * libbluray call selectPlaylistN. When that playlist ends (EndOfMediaEvent, from libbluray's END_OF_PLAYLIST), it does
 * the same once more, as a disc's menu does after its intro: a second selectPlaylistN. Compiled with -source 1.3
 * -target 1.3 (class version 47); no generics.
 */
public class TitleXlet implements Xlet, ControllerListener {
    private Player player;
    private int plays;

    public void initXlet(XletContext ctx) {
    }

    public void startXlet() {
        System.out.println("TitleXlet: start");
        play();
    }

    private synchronized void play() {
        try {
            plays++;
            player = Manager.createPlayer(new MediaLocator("bd://PLAYLIST:00000"));
            player.addControllerListener(this);
            player.start();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public void controllerUpdate(ControllerEvent event) {
        if (event instanceof EndOfMediaEvent && plays == 1) {
            System.out.println("TitleXlet: end of playlist");
            play();
        }
    }

    public void pauseXlet() {
    }

    public void destroyXlet(boolean unconditional) {
    }
}
