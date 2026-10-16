package conformance;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.List;

public class Io {
    static File root;

    static String rel(File f) {
        String p = f.getPath();
        String base = root.getParentFile().getPath();
        return p.startsWith(base) ? p.substring(base.length()) : p;
    }

    static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    public static void main(String[] args) throws Exception {
        File tmp = new File(System.getProperty("java.io.tmpdir"));
        root = new File(tmp, "bdjweb-conformance-io");
        deleteTree(root);
        System.out.println("root-exists-before " + root.exists());
        System.out.println("mkdir " + root.mkdir() + " " + root.isDirectory() + " " + root.isFile());
        System.out.println("mkdir-again " + root.mkdir());
        File deep = new File(root, "a/b/c");
        System.out.println("mkdirs " + deep.mkdirs() + " " + deep.isDirectory());

        File f = new File(root, "data.bin");
        FileOutputStream out = new FileOutputStream(f);
        byte[] payload = new byte[256];
        for (int i = 0; i < payload.length; i++) payload[i] = (byte) i;
        out.write(payload);
        out.write(0x7f);
        out.close();
        System.out.println("length " + f.length() + " exists=" + f.exists() + " file=" + f.isFile() + " dir=" + f.isDirectory());

        FileInputStream in = new FileInputStream(f);
        int first = in.read();
        byte[] buf = new byte[10];
        int n = in.read(buf);
        long skipped = in.skip(100);
        int rest = 0;
        byte[] big = new byte[1024];
        int r;
        while ((r = in.read(big)) > 0) rest += r;
        System.out.println("read " + first + " " + n + " " + buf[9] + " skipped=" + skipped + " rest=" + rest + " eof=" + in.read());
        in.close();

        RandomAccessFile raf = new RandomAccessFile(f, "r");
        raf.seek(200);
        int at200 = raf.read();
        raf.seek(256);
        int last = raf.read();
        long ptr = raf.getFilePointer();
        raf.seek(10);
        byte[] four = new byte[4];
        raf.readFully(four);
        System.out.println("raf " + at200 + " " + last + " " + ptr + " " + four[0] + " " + four[3] + " len=" + raf.length());
        raf.close();
        RandomAccessFile rw = new RandomAccessFile(new File(root, "rw.bin"), "rw");
        rw.writeInt(0x01020304);
        rw.writeUTF("hi");
        rw.seek(1);
        System.out.println("raf-rw " + rw.read() + " " + rw.length());
        rw.setLength(2);
        System.out.println("raf-trunc " + rw.length());
        rw.close();

        File text = new File(root, "text.txt");
        FileOutputStream tout = new FileOutputStream(text);
        tout.write("line one\n\u65e5\u672c\u8a9e line two\r\nthird".getBytes("UTF-8"));
        tout.close();
        BufferedReader br = new BufferedReader(new InputStreamReader(new FileInputStream(text), "UTF-8"));
        String line;
        int count = 0;
        while ((line = br.readLine()) != null) {
            count++;
            System.out.println("line" + count + " " + line.length() + " " + (int) line.charAt(line.length() - 1) + " " + (int) line.charAt(0));
        }
        br.close();

        FileOutputStream app = new FileOutputStream(text, true);
        app.write("!".getBytes("UTF-8"));
        app.close();
        System.out.println("append-length " + text.length());

        List<String> names = new ArrayList<String>();
        for (String s : root.list()) names.add(s);
        java.util.Collections.sort(names);
        System.out.println("list " + names);
        System.out.println("list-file " + (f.list() == null) + " list-missing " + (new File(root, "nope").list() == null));

        File renamed = new File(root, "renamed.bin");
        System.out.println("rename " + f.renameTo(renamed) + " " + f.exists() + " " + renamed.exists() + " " + renamed.length());
        System.out.println("delete " + renamed.delete() + " " + renamed.exists() + " " + renamed.delete());
        System.out.println("delete-nonempty " + new File(root, "a").delete());
        System.out.println("rel-path " + rel(renamed) + " " + renamed.getName() + " " + rel(renamed.getParentFile()));
        System.out.println("canwrite " + text.canRead() + " " + text.canWrite());
        try {
            new FileInputStream(new File(root, "missing.txt"));
        } catch (java.io.FileNotFoundException e) {
            System.out.println("fnfe " + e.getMessage().replace(root.getPath(), "<root>"));
        }
        File created = new File(root, "created.txt");
        System.out.println("createNewFile " + created.createNewFile() + " " + created.createNewFile());

        deleteTree(root);
        System.out.println("cleaned " + root.exists());
    }
}
