package conformance;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.JarURLConnection;
import java.net.URL;
import java.net.URLConnection;
import java.util.jar.JarEntry;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

// A jar: URL read through JarURLConnection (as a disc's resources are when its class loader hands out jar: URLs), and
// an http: URL, which discs build for BD-Live before they connect.
public class Urls {
    static String readAll(InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) >= 0) sb.append((char) c);
        in.close();
        return sb.toString();
    }

    public static void main(String[] args) throws Exception {
        File jar = new File(System.getProperty("java.io.tmpdir"), "bdjweb-conformance-urls.jar");
        jar.delete();
        ZipOutputStream z = new ZipOutputStream(new FileOutputStream(jar));
        String[] names = {"res/hello.txt", "res/menu/items.txt"};
        String[] bodies = {"hello, jar\n", "play\nchapters\nsetup\n"};
        for (int i = 0; i < names.length; i++) {
            ZipEntry e = new ZipEntry(names[i]);
            e.setTime(1000000000000L);
            z.putNextEntry(e);
            z.write(bodies[i].getBytes("UTF-8"));
            z.closeEntry();
        }
        z.close();

        String base = "jar:" + jar.toURI().toURL() + "!/";
        URL u = new URL(base + "res/hello.txt");
        System.out.println("protocol " + u.getProtocol() + " file-ends " + u.getFile().endsWith("!/res/hello.txt"));
        URLConnection c = u.openConnection();
        System.out.println("connection " + (c instanceof JarURLConnection));
        JarURLConnection jc = (JarURLConnection) c;
        System.out.println("entry " + jc.getEntryName() + " jar-file-ends "
            + jc.getJarFileURL().getPath().endsWith("bdjweb-conformance-urls.jar"));
        JarEntry je = jc.getJarEntry();
        System.out.println("jar-entry " + je.getName() + " " + je.getSize());
        System.out.println("content-length " + jc.getContentLength());
        System.out.println("read " + readAll(jc.getInputStream()).replace('\n', '|'));
        System.out.println("open-stream " + readAll(new URL(base + "res/menu/items.txt").openStream()).replace('\n', '|'));
        System.out.println("relative " + readAll(new URL(new URL(base + "res/menu/items.txt"), "../hello.txt").openStream()).replace('\n', '|'));
        try {
            new URL(base + "res/none.txt").openStream();
            System.out.println("missing opened");
        } catch (java.io.FileNotFoundException e) {
            System.out.println("missing " + e.getClass().getName());
        }

        URL h = new URL("http://bdlive.example.invalid:8080/path/check.xml?disc=1");
        System.out.println("http " + h.getProtocol() + " " + h.getHost() + " " + h.getPort() + " " + h.getPath() + " " + h.getQuery());
        System.out.println("http-external " + h.toExternalForm().replace('?', '&'));
        jar.delete();
    }
}
