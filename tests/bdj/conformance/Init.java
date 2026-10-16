package conformance;

public class Init {
    static void log(String s) { System.out.println(s); }

    static int note(String s, int v) {
        log("init " + s);
        return v;
    }

    static class Bad {
        static int value = compute();
        static int compute() { throw new IllegalStateException("clinit failed"); }
        static void touch() { }
    }

    interface Face {
        int CONST = 5;
        int NONCONST = note("Face.NONCONST", 6);
    }

    static class Base {
        static int b = note("Base.b", 1);
        Base() { log("Base()"); }
    }

    static class Derived extends Base implements Face {
        static int d = note("Derived.d", 2);
        Derived() { super(); log("Derived()"); }
    }

    static class Lazy {
        static final int CONSTANT = 10;
        static final Integer BOXED = Integer.valueOf(11);
        static { log("init Lazy"); }
    }

    public static void main(String[] args) {
        try {
            Bad.touch();
        } catch (Throwable t) {
            log("first " + t.getClass().getName() + " cause=" + t.getCause().getClass().getName() + ":" + t.getCause().getMessage());
        }
        try {
            Bad.touch();
        } catch (Throwable t) {
            log("second " + t.getClass().getName());
        }
        try {
            log("value " + Bad.value);
        } catch (Throwable t) {
            log("third " + t.getClass().getName());
        }
        try {
            new Bad();
        } catch (Throwable t) {
            log("new " + t.getClass().getName());
        }
        log("before derived");
        new Derived();
        log("after derived");
        log("const-no-init " + Face.CONST);
        log("nonconst " + Face.NONCONST);
        log("lazy-const " + Lazy.CONSTANT);
        log("lazy-boxed " + Lazy.BOXED);
        log("done");
    }
}
