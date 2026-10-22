package conformance;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileFilter;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.FilenameFilter;
import java.io.PrintWriter;
import java.util.Arrays;

// FileWriter (with FileReader, FilenameFilter and FileFilter), as discs save their settings: under the directory given
// as the first argument (the JVM tests pass /persistent), or java.io.tmpdir on HotSpot.
public class FileWriting {
    static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    static String read(File f) throws Exception {
        BufferedReader in = new BufferedReader(new FileReader(f));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = in.readLine()) != null) sb.append('[').append(line).append(']');
        in.close();
        return sb.toString();
    }

    public static void main(String[] args) throws Exception {
        File base = new File(args.length > 0 ? args[0] : System.getProperty("java.io.tmpdir"));
        File root = new File(base, "bdjweb-conformance-filewriting");
        deleteTree(root);
        System.out.println("mkdirs " + root.mkdirs());

        File f = new File(root, "settings.txt");
        FileWriter w = new FileWriter(f);
        w.write("volume=7\n");
        w.write("lang=jpn\n", 0, 9);
        w.write(new char[] {'x', '=', '1', '\n'});
        w.close();
        System.out.println("written " + f.length() + " " + read(f));

        FileWriter a = new FileWriter(f, true);
        a.append("resume=").append("01:02:03").append('\n');
        a.flush();
        a.close();
        System.out.println("appended " + f.length() + " " + read(f));

        PrintWriter p = new PrintWriter(new BufferedWriter(new FileWriter(new File(root, "log.dat"))));
        for (int i = 0; i < 3; i++) p.println("entry " + i + " " + (i * 1.5));
        p.close();
        System.out.println("printed " + read(new File(root, "log.dat")));

        FileWriter u = new FileWriter(new File(root, "u.txt").getPath());
        u.write("caf\u00e9 \u65e5\u672c");
        u.close();
        System.out.println("utf8-bytes " + new File(root, "u.txt").length());

        new File(root, "sub").mkdir();
        String[] names = root.list(new FilenameFilter() {
            public boolean accept(File dir, String name) { return name.endsWith(".txt"); }
        });
        Arrays.sort(names);
        System.out.println("filenamefilter " + Arrays.toString(names));
        File[] dirs = root.listFiles(new FileFilter() {
            public boolean accept(File x) { return x.isDirectory(); }
        });
        System.out.println("filefilter " + dirs.length + " " + dirs[0].getName());

        FileWriter t = new FileWriter(f);
        t.write("short");
        t.close();
        System.out.println("truncated " + f.length() + " " + read(f));

        try {
            new FileWriter(new File(root, "missing/dir/x.txt"));
            System.out.println("no-dir opened");
        } catch (java.io.IOException e) {
            System.out.println("no-dir " + e.getClass().getName());
        }
        deleteTree(root);
        System.out.println("deleted " + root.exists());
    }
}
