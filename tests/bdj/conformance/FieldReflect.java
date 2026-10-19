package conformance;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;

// Fields read and written through reflection: primitive types, static and instance, final and not (HotSpot's
// sun.reflect.Unsafe*FieldAccessorImpl classes).
public class FieldReflect {
    static float SF = 1.5f;
    static long SL = 1234567890123L;
    static double SD = 2.25;
    static int SI = 7;
    static short SS = -3;
    static byte SB = 9;
    static char SC = 'q';
    static boolean SZ = true;
    static Object SO = "obj";
    static final float FINAL_F = 0.125f;
    float f = 3.75f;
    long l = -42L;
    double d = 6.5;
    boolean z;

    public static void main(String[] args) throws Exception {
        Class<FieldReflect> c = FieldReflect.class;
        System.out.println("static-float " + c.getDeclaredField("SF").getFloat(null) + " " + c.getDeclaredField("SF").get(null));
        System.out.println("static-long " + c.getDeclaredField("SL").getLong(null) + " as-float " + c.getDeclaredField("SL").getFloat(null));
        System.out.println("static-double " + c.getDeclaredField("SD").getDouble(null));
        System.out.println("static-int " + c.getDeclaredField("SI").getInt(null) + " as-long " + c.getDeclaredField("SI").getLong(null));
        System.out.println("static-short " + c.getDeclaredField("SS").getShort(null) + " byte " + c.getDeclaredField("SB").getByte(null));
        System.out.println("static-char " + c.getDeclaredField("SC").getChar(null) + " bool " + c.getDeclaredField("SZ").getBoolean(null));
        System.out.println("static-object " + c.getDeclaredField("SO").get(null));
        Field ff = c.getDeclaredField("FINAL_F");
        System.out.println("static-final " + ff.getFloat(null) + " " + Modifier.isFinal(ff.getModifiers()));

        Field sf = c.getDeclaredField("SF");
        sf.setFloat(null, 9.5f);
        Field sl = c.getDeclaredField("SL");
        sl.setLong(null, 77L);
        System.out.println("static-set " + SF + " " + SL);
        sl.set(null, Long.valueOf(78L));
        System.out.println("static-set-boxed " + SL);

        FieldReflect o = new FieldReflect();
        System.out.println("float " + c.getDeclaredField("f").getFloat(o) + " long " + c.getDeclaredField("l").getLong(o)
            + " double " + c.getDeclaredField("d").getDouble(o));
        c.getDeclaredField("f").setFloat(o, -1.25f);
        c.getDeclaredField("l").set(o, Long.valueOf(5L));
        c.getDeclaredField("z").setBoolean(o, true);
        System.out.println("set " + o.f + " " + o.l + " " + o.z);
        try {
            c.getDeclaredField("SI").setLong(null, 1L);
            System.out.println("narrow accepted");
        } catch (IllegalArgumentException e) {
            System.out.println("narrow " + e.getClass().getName());
        }
        try {
            ff.setFloat(null, 1f);
            System.out.println("final-set accepted");
        } catch (IllegalAccessException e) {
            System.out.println("final-set " + e.getClass().getName());
        }
    }
}
