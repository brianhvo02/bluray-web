package conformance;

/**
 * Every operand goes through a method call (i, l, f, d), so javac cannot constant-fold and each case runs its bytecode
 * (idiv, f2i, lushr, ...) at run time.
 */
public class Arith {
    static int i(int v) { return v; }
    static long l(long v) { return v; }
    static float f(float v) { return v; }
    static double d(double v) { return v; }

    public static void main(String[] args) {
        int imin = i(Integer.MIN_VALUE);
        int m1 = i(-1);
        long lmin = l(Long.MIN_VALUE);
        long lm1 = l(-1L);
        System.out.println("idiv-min " + (imin / m1));
        System.out.println("irem-min " + (imin % m1));
        System.out.println("ldiv-min " + (lmin / lm1));
        System.out.println("lrem-min " + (lmin % lm1));
        try {
            System.out.println(i(1) / i(0));
        } catch (ArithmeticException e) {
            System.out.println("idiv-zero " + e.getMessage());
        }
        try {
            System.out.println(i(1) % i(0));
        } catch (ArithmeticException e) {
            System.out.println("irem-zero " + e.getMessage());
        }
        try {
            System.out.println(l(1L) / l(0L));
        } catch (ArithmeticException e) {
            System.out.println("ldiv-zero " + e.getMessage());
        }
        try {
            System.out.println(l(1L) % l(0L));
        } catch (ArithmeticException e) {
            System.out.println("lrem-zero " + e.getMessage());
        }
        System.out.println("fdiv-zero " + (f(1.0f) / f(0f)));
        System.out.println("ddiv-zero " + (d(-1.0) / d(0.0)));
        System.out.println("drem-zero " + (d(1.0) % d(0.0)));
        System.out.println("irem-neg " + (i(-7) % i(3)) + " " + (i(7) % i(-3)) + " " + (i(-7) % i(-3)));
        System.out.println("idiv-neg " + (i(-7) / i(2)) + " " + (i(7) / i(-2)));
        System.out.println("lrem-neg " + (l(-7L) % l(3L)) + " " + (l(7L) % l(-3L)));
        System.out.println("ldiv-neg " + (l(-7L) / l(2L)) + " " + (l(7L) / l(-2L)));
        System.out.println("frem-neg " + (f(-7.5f) % f(2f)) + " " + (d(7.5) % d(-2.0)));
        System.out.println("f2i-nan " + (int) f(Float.NaN));
        System.out.println("f2i-big " + (int) f(1e20f));
        System.out.println("f2i-neg-big " + (int) f(-1e20f));
        System.out.println("f2i-3.9e10 " + (int) f(3.9e10f));
        System.out.println("d2i-nan " + (int) d(Double.NaN));
        System.out.println("d2i-big " + (int) d(1e300));
        System.out.println("d2l-nan " + (long) d(Double.NaN));
        System.out.println("d2l-neg-big " + (long) d(-1e30));
        System.out.println("d2l-big " + (long) d(1e30));
        System.out.println("f2l-big " + (long) f(1e30f));
        System.out.println("f2l-nan " + (long) f(Float.NaN));
        System.out.println("i2f-large " + (float) i(16777217));
        System.out.println("l2f " + (float) l(123456789012345678L));
        System.out.println("l2d " + (double) l(9007199254740993L));
        System.out.println("i2d " + (double) i(imin));
        System.out.println("d2i-neg-zero " + (int) d(-0.0));
        System.out.println("d2f " + (float) d(1e40));
        System.out.println("d2f-small " + (float) d(1e-50));
        System.out.println("shl-33 " + (i(1) << i(33)));
        System.out.println("shl-32 " + (i(5) << i(32)));
        System.out.println("shr-neg " + (i(-8) >> i(33)));
        System.out.println("ushr-28 " + (i(-1) >>> i(28)));
        System.out.println("ushr-neg-0 " + (i(-1) >>> i(32)));
        System.out.println("lshl-65 " + (l(1L) << i(65)));
        System.out.println("lushr-60 " + (l(-1L) >>> i(60)));
        System.out.println("lshr-neg " + (l(-8L) >> i(66)));
        System.out.println("fcmp-nan " + Float.compare(f(Float.NaN), f(1f)));
        float n = f(Float.NaN);
        float one = f(1f);
        System.out.println("fcmp " + (n < one) + " " + (n > one) + " " + (n <= one) + " " + (n >= one) + " " + (n == n) + " " + (n != n));
        double dn = d(Double.NaN);
        double done = d(1.0);
        System.out.println("dcmp " + (dn < done) + " " + (dn > done) + " " + (dn <= done) + " " + (dn >= done) + " " + (dn == dn) + " " + (dn != dn));
        System.out.println("fcmp-ord " + (one < f(2f)) + " " + (one > f(2f)) + " " + (one == f(1f)));
        System.out.println("float-add " + (f(0.1f) + f(0.2f)));
        System.out.println("float-ops " + (f(1.1f) * f(1.1f)) + " " + (f(1f) - f(0.9f)) + " " + (f(10f) / f(3f)));
        System.out.println("double-add " + (d(0.1) + d(0.2)));
        System.out.println("double-ops " + (d(1.1) * d(1.1)) + " " + (d(1.0) - d(0.9)) + " " + (d(10.0) / d(3.0)));
        System.out.println("round-neg " + Math.round(d(-2.5)));
        System.out.println("round-pos " + Math.round(d(2.5)));
        System.out.println("round-f " + Math.round(f(-0.5f)));
        System.out.println("dtoa-1e21 " + Double.toString(d(1e21)));
        System.out.println("dtoa-1e7 " + Double.toString(d(1.0E7)));
        System.out.println("dtoa-small " + Double.toString(d(1.0E-3)) + " " + Double.toString(d(9.999E-4)));
        System.out.println("ftoa-1e-5 " + Float.toString(f(1.0e-5f)));
        System.out.println("ftoa-third " + Float.toString(f(1f) / f(3f)));
        System.out.println("hex-m1 " + Integer.toHexString(i(-1)));
        System.out.println("hex-long " + Long.toHexString(lmin));
        System.out.println("binary " + Integer.toBinaryString(i(-8)));
        System.out.println("parse-long-min " + Long.parseLong("-9223372036854775808"));
        System.out.println("char-m1 " + (int) (char) i(-1));
        System.out.println("byte-200 " + (byte) i(200));
        System.out.println("short-70000 " + (short) i(70000));
        System.out.println("byte-neg " + (byte) i(-129) + " " + (short) i(-32769));
        System.out.println("char-add " + (char) (i('a') + i(1)));
        System.out.println("l2i " + (int) l(0x1_2345_6789L));
        System.out.println("int-ovf " + (i(Integer.MAX_VALUE) + i(1)));
        System.out.println("long-ovf " + (l(Long.MAX_VALUE) + l(1)));
        System.out.println("imul-ovf " + (i(123456789) * i(987654321)));
        System.out.println("lmul-ovf " + (l(123456789012L) * l(987654321098L)));
        System.out.println("isub-ovf " + (imin - i(1)) + " " + (lmin - l(1)));
        System.out.println("neg-min " + (-imin) + " " + (-lmin));
        System.out.println("neg-zero " + (-f(0.0f)) + " " + (f(0.0f) == -f(0.0f)) + " " + Float.compare(f(0.0f), -f(0.0f)));
        System.out.println("neg-zero-d " + (-d(0.0)) + " " + (d(0.0) == -d(0.0)));
        System.out.println("abs-min " + Math.abs(imin));
        System.out.println("bitops " + (i(0x5555) ^ i(0xFFFF)) + " " + (~i(7)) + " " + (i(0xF0) & i(0x3C)) + " " + (i(0xF0) | i(0x0F)) + " " + (l(0xF0F0L) ^ l(-1L)));
        System.out.println("sin " + StrictMath.sin(d(1.0)));
        System.out.println("exp " + StrictMath.exp(d(1.0)));
        System.out.println("log " + StrictMath.log(d(10.0)));
        System.out.println("pow " + StrictMath.pow(d(2.0), d(0.5)));
        System.out.println("sqrt " + Math.sqrt(d(2.0)));
        System.out.println("atan2 " + StrictMath.atan2(d(1.0), d(2.0)));
        System.out.println("floor-ceil " + Math.floor(d(-1.5)) + " " + Math.ceil(d(-1.5)));
        System.out.println("minmax " + Math.min(d(-0.0), d(0.0)) + " " + Math.max(d(Double.NaN), d(1.0)));
        System.out.println("bits " + Float.floatToIntBits(f(1.5f)) + " " + Double.doubleToLongBits(d(-2.0)));
        System.out.println("bitcount " + Integer.bitCount(i(0xF0F0)) + " " + Long.numberOfTrailingZeros(l(1L << 40)) + " " + Integer.reverse(i(1)));
        long acc = 0;
        for (int k = 0; k < 20; k++) acc = acc * 31 + (k ^ (acc >>> 7));
        System.out.println("loop-mix " + acc);
    }
}
