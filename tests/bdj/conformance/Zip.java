package conformance;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.zip.CRC32;
import java.util.zip.Deflater;
import java.util.zip.Inflater;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

public class Zip {
    public static void main(String[] args) throws Exception {
        byte[] storedData = "stored entry data".getBytes("UTF-8");
        CRC32 sc = new CRC32();
        sc.update(storedData, 0, storedData.length);

        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        ZipOutputStream zos = new ZipOutputStream(bos);
        ZipEntry stored = new ZipEntry("dir/stored.txt");
        stored.setMethod(ZipEntry.STORED);
        stored.setSize(storedData.length);
        stored.setCompressedSize(storedData.length);
        stored.setCrc(sc.getValue());
        stored.setTime(0L);
        zos.putNextEntry(stored);
        zos.write(storedData);
        zos.closeEntry();

        StringBuilder rep = new StringBuilder();
        for (int i = 0; i < 200; i++) rep.append("deflate me ");
        byte[] deflatedData = rep.toString().getBytes("UTF-8");
        ZipEntry deflated = new ZipEntry("deflated.txt");
        deflated.setTime(0L);
        zos.putNextEntry(deflated);
        zos.write(deflatedData);
        zos.closeEntry();
        zos.finish();
        zos.close();
        byte[] zip = bos.toByteArray();
        System.out.println("zip-starts " + (zip[0] & 0xff) + " " + (zip[1] & 0xff) + " " + (zip[2] & 0xff) + " " + (zip[3] & 0xff));

        ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(zip));
        ZipEntry e;
        while ((e = zis.getNextEntry()) != null) {
            ByteArrayOutputStream content = new ByteArrayOutputStream();
            byte[] buf = new byte[64];
            int n;
            while ((n = zis.read(buf)) > 0) content.write(buf, 0, n);
            byte[] bytes = content.toByteArray();
            CRC32 c = new CRC32();
            c.update(bytes, 0, bytes.length);
            String text = new String(bytes, "UTF-8");
            System.out.println("entry " + e.getName() + " method=" + e.getMethod() + " len=" + bytes.length + " crc=" + Long.toHexString(c.getValue()) + " head=" + text.substring(0, 11));
            zis.closeEntry();
        }
        zis.close();

        CRC32 known = new CRC32();
        byte[] kb = "123456789".getBytes("US-ASCII");
        known.update(kb, 0, kb.length);
        System.out.println("crc32 " + Long.toHexString(known.getValue()));
        known.reset();
        known.update(0x41);
        System.out.println("crc32-byte " + Long.toHexString(known.getValue()));
        java.util.zip.Adler32 ad = new java.util.zip.Adler32();
        ad.update(kb, 0, kb.length);
        System.out.println("adler32 " + Long.toHexString(ad.getValue()));

        byte[] data = new byte[100 * 1024];
        for (int i = 0; i < data.length; i++) data[i] = (byte) ((i * 31 + (i >> 8)) % 251);
        Deflater d = new Deflater(Deflater.BEST_COMPRESSION);
        d.setInput(data);
        d.finish();
        ByteArrayOutputStream comp = new ByteArrayOutputStream();
        byte[] chunk = new byte[1000];
        while (!d.finished()) {
            int n = d.deflate(chunk);
            comp.write(chunk, 0, n);
        }
        long totalIn = d.getTotalIn();
        d.end();
        byte[] compressed = comp.toByteArray();
        System.out.println("deflate-in " + totalIn + " smaller=" + (compressed.length < data.length));

        Inflater inf = new Inflater();
        inf.setInput(compressed);
        byte[] back = new byte[data.length];
        int got = 0;
        while (!inf.finished() && got < back.length) {
            int n = inf.inflate(back, got, Math.min(777, back.length - got));
            if (n == 0 && (inf.needsInput() || inf.needsDictionary())) break;
            got += n;
        }
        inf.end();
        System.out.println("inflate " + got + " same=" + java.util.Arrays.equals(data, back));
        CRC32 dc = new CRC32();
        dc.update(back, 0, back.length);
        System.out.println("round-crc " + Long.toHexString(dc.getValue()));

        Inflater bad = new Inflater();
        bad.setInput(new byte[] {1, 2, 3, 4, 5});
        try {
            bad.inflate(new byte[10]);
        } catch (java.util.zip.DataFormatException ex) {
            System.out.println("dataformat " + ex.getMessage());
        }
        bad.end();

        java.util.zip.GZIPOutputStream gz = null;
        ByteArrayOutputStream gb = new ByteArrayOutputStream();
        gz = new java.util.zip.GZIPOutputStream(gb);
        gz.write(deflatedData);
        gz.close();
        java.util.zip.GZIPInputStream gi = new java.util.zip.GZIPInputStream(new ByteArrayInputStream(gb.toByteArray()));
        int total = 0;
        byte[] gbuf = new byte[512];
        int gn;
        while ((gn = gi.read(gbuf)) > 0) total += gn;
        System.out.println("gzip " + total);
    }
}
