package conformance;

/** Runs before the JDK boots: no String, no main. Each method returns a fixed int. */
public class Bare {
    static int counter;
    int value;

    static class Boom extends RuntimeException {
    }

    static abstract class Shape {
        abstract int area();
    }

    static class Square extends Shape {
        int area() { return 9; }
    }

    static class Rect extends Shape {
        int area() { return 12; }
    }

    interface Counter {
        int next();
    }

    static class Three implements Counter {
        public int next() { return 3; }
    }

    public static int sum() {
        int s = 0;
        for (int i = 1; i <= 100; i++) s += i;
        return s;
    }

    static int fib(int n) {
        return n < 2 ? n : fib(n - 1) + fib(n - 2);
    }

    public static int fib() { return fib(20); }

    public static int arrays() {
        int[] a = new int[10];
        for (int i = 0; i < 10; i++) a[i] = i;
        int s = 0;
        for (int i = 0; i < a.length; i++) s += a[i];
        return s;
    }

    public static int longs() {
        return (int) ((1L << 40) / 3 % 1000);
    }

    public static int fields() {
        counter = 3;
        Bare b = new Bare();
        b.value = 4;
        return counter + b.value;
    }

    public static int virtual() {
        Shape[] s = new Shape[2];
        s[0] = new Square();
        s[1] = new Rect();
        return s[0].area() + s[1].area();
    }

    public static int iface() {
        Counter c = new Three();
        return c.next();
    }

    public static int tableswitch() {
        int x = 2;
        switch (x) {
            case 0: return 10;
            case 1: return 1;
            case 2: return 2;
            case 3: return 3;
            default: return -1;
        }
    }

    public static int lookupswitch() {
        int x = 30;
        switch (x) {
            case 5: return 5;
            case 30: return 30;
            case 1000: return 1000;
            default: return -1;
        }
    }

    public static int catches() {
        try {
            throw new Boom();
        } catch (Boom e) {
            return 1;
        }
    }
}
