package conformance;

import java.awt.Polygon;
import java.awt.Rectangle;
import java.awt.image.IndexColorModel;

// java.awt.image.IndexColorModel lookups and java.awt.Polygon hit tests.
public class Awt {
    public static void main(String[] args) throws Exception {
        byte[] r = {0, (byte) 255, 0, 0, (byte) 128};
        byte[] g = {0, 0, (byte) 255, 0, (byte) 128};
        byte[] b = {0, 0, 0, (byte) 255, (byte) 128};
        byte[] a = {0, (byte) 255, (byte) 200, (byte) 100, (byte) 255};
        IndexColorModel cm = new IndexColorModel(8, 5, r, g, b, a);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 5; i++) sb.append(' ').append(Integer.toHexString(cm.getRGB(i)));
        System.out.println("rgb" + sb);
        System.out.println("components " + cm.getRed(4) + " " + cm.getGreen(2) + " " + cm.getBlue(3) + " " + cm.getAlpha(3));
        System.out.println("size " + cm.getMapSize() + " transparent " + cm.getTransparentPixel() + " transparency "
            + cm.getTransparency() + " alpha " + cm.hasAlpha() + " bits " + cm.getPixelSize());
        IndexColorModel opaque = new IndexColorModel(2, 3, r, g, b, 0);
        System.out.println("opaque " + Integer.toHexString(opaque.getRGB(0)) + " " + Integer.toHexString(opaque.getRGB(1))
            + " transparent " + opaque.getTransparentPixel() + " transparency " + opaque.getTransparency());
        int[] rgbs = new int[5];
        cm.getRGBs(rgbs);
        System.out.println("rgbs " + Integer.toHexString(rgbs[2]));
        Object px = cm.getDataElements(0xff00ff00, null);
        System.out.println("data-elements " + ((byte[]) px)[0]);

        Polygon p = new Polygon(new int[] {10, 50, 30}, new int[] {10, 10, 40}, 3);
        System.out.println("contains " + p.contains(30, 20) + " " + p.contains(5, 5) + " " + p.contains(49, 11) + " " + p.contains(10, 10));
        System.out.println("bounds " + p.getBounds());
        p.addPoint(10, 40);
        System.out.println("added " + p.npoints + " " + p.contains(12, 38) + " " + p.getBounds());
        p.translate(5, -5);
        System.out.println("translated " + p.contains(35, 15) + " " + p.getBounds());
        System.out.println("rect " + p.contains(new Rectangle(20, 10, 4, 4)) + " " + p.intersects(0, 0, 16, 6));
    }
}
