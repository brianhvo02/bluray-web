package conformance;

public class Arith {
    static int zero() { return 0; }
    static float nanF() { return Float.NaN; }
    static double nanD() { return Double.NaN; }

    public static void main(String[] args) {
        int imin = Integer.MIN_VALUE;
        int m1 = -1;
        long lmin = Long.MIN_VALUE;
        long lm1 = -1L;
        System.out.println("idiv-min " + (imin / m1));
        System.out.println("irem-min " + (imin % m1));
        System.out.println("ldiv-min " + (lmin / lm1));
        System.out.println("lrem-min " + (lmin % lm1));
        try {
            System.out.println(1 / zero());
        } catch (ArithmeticException e) {
            System.out.println("idiv-zero " + e.getMessage());
        }
        try {
            System.out.println(1 % zero());
        } catch (ArithmeticException e) {
            System.out.println("irem-zero " + e.getMessage());
        }
        try {
            System.out.println(1L / (long) zero());
        } catch (ArithmeticException e) {
            System.out.println("ldiv-zero " + e.getMessage());
        }
        System.out.println("fdiv-zero " + (1.0f / zero()));
        System.out.println("ddiv-zero " + (-1.0 / zero()));
        System.out.println("drem-zero " + (1.0 % zero()));
        System.out.println("irem-neg " + (-7 % 3) + " " + (7 % -3) + " " + (-7 % -3));
        System.out.println("idiv-neg " + (-7 / 2) + " " + (7 / -2));
        System.out.println("lrem-neg " + (-7L % 3L) + " " + (7L % -3L));
        System.out.println("frem-neg " + (-7.5f % 2f) + " " + (7.5 % -2.0));
        System.out.println("f2i-nan " + (int) nanF());
        System.out.println("f2i-big " + (int) 1e20f);
        System.out.println("f2i-neg-big " + (int) -1e20f);
        System.out.println("f2i-3.9e10 " + (int) 3.9e10f);
        System.out.println("d2i-nan " + (int) nanD());
        System.out.println("d2l-nan " + (long) Double.NaN);
        System.out.println("d2l-neg-big " + (long) -1e30);
        System.out.println("d2l-big " + (long) 1e30);
        System.out.println("f2l-big " + (long) 1e30f);
        System.out.println("i2f-large " + (float) 16777217);
        System.out.println("l2f " + (float) 123456789012345678L);
        System.out.println("l2d " + (double) 9007199254740993L);
        System.out.println("d2i-neg-zero " + (int) -0.0);
        System.out.println("d2f " + (float) 1e40);
        System.out.println("shl-33 " + (1 << 33));
        System.out.println("shl-32 " + (5 << 32));
        System.out.println("shr-neg " + (-8 >> 33));
        System.out.println("ushr-28 " + (-1 >>> 28));
        System.out.println("lshl-65 " + (1L << 65));
        System.out.println("lushr-60 " + (-1L >>> 60));
        System.out.println("lshr-neg " + (-8L >> 66));
        System.out.println("fcmp-nan " + Float.compare(Float.NaN, 1f));
        float n = nanF();
        System.out.println("fcmpl " + (n < 1f) + " " + (n > 1f) + " " + (n <= 1f) + " " + (n >= 1f) + " " + (n == n) + " " + (n != n));
        double dn = nanD();
        System.out.println("dcmp " + (dn < 1.0) + " " + (dn > 1.0) + " " + (dn <= 1.0) + " " + (dn >= 1.0) + " " + (dn == dn) + " " + (dn != dn));
        System.out.println("float-add " + (0.1f + 0.2f));
        System.out.println("double-add " + (0.1 + 0.2));
        System.out.println("round-neg " + Math.round(-2.5));
        System.out.println("round-pos " + Math.round(2.5));
        System.out.println("round-f " + Math.round(-0.5f));
        System.out.println("dtoa-1e21 " + Double.toString(1e21));
        System.out.println("dtoa-1e7 " + Double.toString(1.0E7));
        System.out.println("dtoa-small " + Double.toString(1.0E-3) + " " + Double.toString(9.999E-4));
        System.out.println("ftoa-1e-5 " + Float.toString(1.0e-5f));
        System.out.println("ftoa-third " + Float.toString(1f / 3f));
        System.out.println("hex-m1 " + Integer.toHexString(-1));
        System.out.println("hex-long " + Long.toHexString(Long.MIN_VALUE));
        System.out.println("binary " + Integer.toBinaryString(-8));
        System.out.println("parse-long-min " + Long.parseLong("-9223372036854775808"));
        System.out.println("char-m1 " + (int) (char) -1);
        System.out.println("byte-200 " + (byte) 200);
        System.out.println("short-70000 " + (short) 70000);
        System.out.println("char-add " + (char) ('a' + 1));
        System.out.println("int-ovf " + (Integer.MAX_VALUE + 1));
        System.out.println("long-ovf " + (Long.MAX_VALUE + 1));
        System.out.println("imul-ovf " + (123456789 * 987654321));
        System.out.println("lmul-ovf " + (123456789012L * 987654321098L));
        System.out.println("neg-min " + (-imin) + " " + (-lmin));
        System.out.println("neg-zero " + (-0.0f) + " " + (0.0f == -0.0f) + " " + Float.compare(0.0f, -0.0f));
        System.out.println("abs-min " + Math.abs(imin));
        System.out.println("ixor " + (0x5555 ^ 0xFFFF) + " " + (~7));
        System.out.println("sin " + StrictMath.sin(1.0));
        System.out.println("exp " + StrictMath.exp(1.0));
        System.out.println("log " + StrictMath.log(10.0));
        System.out.println("pow " + StrictMath.pow(2.0, 0.5));
        System.out.println("sqrt " + Math.sqrt(2.0));
        System.out.println("atan2 " + StrictMath.atan2(1.0, 2.0));
        System.out.println("floor-ceil " + Math.floor(-1.5) + " " + Math.ceil(-1.5));
        System.out.println("minmax " + Math.min(-0.0, 0.0) + " " + Math.max(Double.NaN, 1.0));
        System.out.println("bits " + Float.floatToIntBits(1.5f) + " " + Double.doubleToLongBits(-2.0));
        System.out.println("bitcount " + Integer.bitCount(0xF0F0) + " " + Long.numberOfTrailingZeros(1L << 40) + " " + Integer.reverse(1));
    }
}
