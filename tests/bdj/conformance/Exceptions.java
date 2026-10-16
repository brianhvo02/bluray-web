package conformance;

public class Exceptions {
    int field;

    static class Custom extends Exception {
        Custom(String m, Throwable cause) { super(m, cause); }
    }

    @SuppressWarnings("finally")
    static int finallyReturn() {
        try {
            throw new RuntimeException("lost");
        } finally {
            return 42;
        }
    }

    static int finallyOrder(StringBuilder sb) {
        try {
            sb.append("try,");
            return 1;
        } catch (RuntimeException e) {
            sb.append("catch,");
            return 2;
        } finally {
            sb.append("finally,");
        }
    }

    static void thrower() {
        throw new IllegalStateException("from thrower");
    }

    static void rethrow() throws Custom {
        try {
            thrower();
        } catch (IllegalStateException e) {
            throw new Custom("wrapped", e);
        }
    }

    public static void main(String[] args) {
        StringBuilder sb = new StringBuilder();
        int r = finallyOrder(sb);
        System.out.println("order " + r + " " + sb);
        System.out.println("finally-return " + finallyReturn());

        StringBuilder n = new StringBuilder();
        try {
            try {
                try {
                    n.append("a");
                    throw new RuntimeException("inner");
                } finally {
                    n.append("b");
                }
            } catch (RuntimeException e) {
                n.append("c:").append(e.getMessage());
                throw new IllegalArgumentException("outer");
            } finally {
                n.append("d");
            }
        } catch (IllegalArgumentException e) {
            n.append("e:").append(e.getMessage());
        }
        System.out.println("nested " + n);

        try {
            rethrow();
        } catch (Custom e) {
            System.out.println("rethrow " + e.getMessage() + " cause=" + e.getCause().getMessage() + " " + e.getCause().getClass().getName());
        }

        try {
            thrower();
        } catch (IllegalStateException e) {
            StackTraceElement[] st = e.getStackTrace();
            System.out.println("trace-top " + st[0].getMethodName() + " " + st[0].getClassName());
            System.out.println("trace-caller " + st[1].getMethodName());
            java.io.StringWriter sw = new java.io.StringWriter();
            e.printStackTrace(new java.io.PrintWriter(sw));
            String first = sw.toString().split("\n")[0].trim();
            System.out.println("print-first " + first);
        }

        try {
            Exceptions e = null;
            System.out.println(e.field);
        } catch (NullPointerException e) {
            System.out.println("npe-field " + e.getClass().getName());
        }
        try {
            Object o = "text";
            Integer i = (Integer) o;
            System.out.println(i);
        } catch (ClassCastException e) {
            System.out.println("cce " + e.getMessage());
        }
        try {
            Object[] o = new Integer[1];
            String[] s = (String[]) o;
            System.out.println(s.length);
        } catch (ClassCastException e) {
            System.out.println("cce-array " + e.getMessage());
        }
        try {
            Object o = null;
            o.toString();
        } catch (NullPointerException e) {
            System.out.println("npe-call");
        }
        try {
            throw new Error("custom error");
        } catch (Throwable t) {
            System.out.println("throwable " + t);
        }
        try {
            Integer.parseInt("12x");
        } catch (NumberFormatException e) {
            System.out.println("nfe " + e.getMessage());
        }
        try {
            "abc".substring(5);
        } catch (StringIndexOutOfBoundsException e) {
            System.out.println("sioobe " + e.getClass().getName());
        }
        Throwable t = new RuntimeException("top", new IllegalStateException("root"));
        System.out.println("tostring " + t + " | " + t.getCause());
        try {
            throw new Custom("s", null);
        } catch (Exception e) {
            System.out.println("catch-super " + (e instanceof Custom));
        }
    }
}
