package conformance;

public class Arrays {
    public static void main(String[] args) {
        int[][][] m = new int[3][4][5];
        m[2][3][4] = 7;
        System.out.println("multi " + m.length + " " + m[0].length + " " + m[0][0].length + " " + m[2][3][4]);
        int[][] jag = new int[2][];
        System.out.println("jagged " + (jag[0] == null) + " " + jag.getClass().getName());
        long[][] lm = new long[2][3];
        lm[1][2] = 1L << 40;
        System.out.println("long2d " + lm[1][2] + " " + lm[0][0]);

        int[] a = {1, 2, 3, 4, 5, 6, 7, 8};
        System.arraycopy(a, 0, a, 2, 6);
        System.out.println("overlap-fwd " + java.util.Arrays.toString(a));
        int[] b = {1, 2, 3, 4, 5, 6, 7, 8};
        System.arraycopy(b, 2, b, 0, 6);
        System.out.println("overlap-back " + java.util.Arrays.toString(b));
        try {
            System.arraycopy(a, 0, a, 5, 6);
        } catch (ArrayIndexOutOfBoundsException e) {
            System.out.println("copy-oob " + e.getMessage());
        }
        try {
            System.arraycopy(a, 0, new long[8], 0, 2);
        } catch (ArrayStoreException e) {
            System.out.println("copy-store " + e.getMessage());
        }

        Object[] objs = new String[2];
        try {
            objs[0] = Integer.valueOf(1);
        } catch (ArrayStoreException e) {
            System.out.println("store " + e.getMessage());
        }
        try {
            int[] z = new int[3];
            z[3] = 1;
        } catch (ArrayIndexOutOfBoundsException e) {
            System.out.println("aioobe " + e.getMessage());
        }
        try {
            int[] z = new int[3];
            System.out.println(z[-1]);
        } catch (ArrayIndexOutOfBoundsException e) {
            System.out.println("aioobe-neg " + e.getMessage());
        }
        try {
            int n = -5;
            int[] z = new int[n];
            System.out.println(z.length);
        } catch (NegativeArraySizeException e) {
            System.out.println("negsize " + e.getMessage());
        }
        try {
            int[] z = null;
            System.out.println(z.length);
        } catch (NullPointerException e) {
            System.out.println("npe-length");
        }

        int[] orig = {3, 1, 2};
        int[] copy = orig.clone();
        copy[0] = 99;
        System.out.println("clone " + orig[0] + " " + copy[0] + " " + (orig != copy));
        int[][] deep = {{1}, {2}};
        int[][] shallow = deep.clone();
        System.out.println("clone-shallow " + (deep[0] == shallow[0]));

        int[] s = {5, 3, 9, -1, 0, 7, 3};
        java.util.Arrays.sort(s);
        System.out.println("sort-int " + java.util.Arrays.toString(s));
        String[] strs = {"pear", "apple", "fig", "banana"};
        java.util.Arrays.sort(strs);
        System.out.println("sort-obj " + java.util.Arrays.toString(strs));
        java.util.Arrays.sort(strs, new java.util.Comparator<String>() {
            public int compare(String x, String y) { return x.length() - y.length(); }
        });
        System.out.println("sort-cmp " + java.util.Arrays.toString(strs));
        int[] big = new int[1000];
        for (int i = 0; i < big.length; i++) big[i] = (i * 7919) % 1000;
        java.util.Arrays.sort(big);
        System.out.println("sort-big " + big[0] + " " + big[500] + " " + big[999]);
        System.out.println("binsearch " + java.util.Arrays.binarySearch(s, 7));
        System.out.println("equals " + java.util.Arrays.equals(new int[]{1, 2}, new int[]{1, 2}) + " " + java.util.Arrays.hashCode(new int[]{1, 2}));
        char[] cs = new char[3];
        java.util.Arrays.fill(cs, 'x');
        System.out.println("fill " + new String(cs));
        System.out.println("types " + new byte[1].getClass().getName() + " " + new String[1][1].getClass().getName());
    }
}
