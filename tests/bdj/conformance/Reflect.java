package conformance;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;

public class Reflect {
    /** On Target.add: its RuntimeVisibleAnnotations bytes are checked in conformance.test.ts. */
    @java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.RUNTIME)
    public @interface Tag {
        String value();

        int weight() default 3;
    }

    public interface Greeter {
        String greet(String name);

        int twice(int x);
    }

    public static class Target {
        private int secret = 11;
        public String label;

        public Target() { label = "default"; }

        public Target(String label, int secret) {
            this.label = label;
            this.secret = secret;
        }

        @Tag("adder")
        public int add(int a, int b) { return a + b; }

        public static String stat(String s) { return "static:" + s; }

        public int secret() { return secret; }

        private String hidden() { return "hidden"; }

        public void fail() { throw new IllegalStateException("boom"); }
    }

    public static void main(String[] args) throws Exception {
        Class<?> c = Class.forName("conformance.Reflect$Target");
        System.out.println("forName " + c.getName() + " " + c.getSimpleName() + " " + (c == Target.class));
        System.out.println("super " + c.getSuperclass().getName() + " " + Modifier.toString(c.getModifiers()));
        try {
            Class.forName("conformance.DoesNotExist");
        } catch (ClassNotFoundException e) {
            System.out.println("cnfe " + e.getMessage());
        }

        List<String> names = new ArrayList<String>();
        for (Method m : c.getDeclaredMethods()) names.add(m.getName());
        java.util.Collections.sort(names);
        System.out.println("methods " + names);
        List<String> fnames = new ArrayList<String>();
        for (Field f : c.getDeclaredFields()) fnames.add(f.getName() + ":" + f.getType().getName());
        java.util.Collections.sort(fnames);
        System.out.println("fields " + fnames);
        System.out.println("ctors " + c.getDeclaredConstructors().length);

        Object t = c.newInstance();
        Method add = c.getMethod("add", int.class, int.class);
        System.out.println("invoke " + add.invoke(t, 3, 4) + " " + add.getReturnType() + " " + add.getParameterTypes().length);
        Method stat = c.getMethod("stat", String.class);
        System.out.println("invoke-static " + stat.invoke(null, "x") + " " + Modifier.isStatic(stat.getModifiers()));
        Method hidden = c.getDeclaredMethod("hidden");
        hidden.setAccessible(true);
        System.out.println("invoke-private " + hidden.invoke(t));
        try {
            c.getMethod("fail").invoke(t);
        } catch (InvocationTargetException e) {
            System.out.println("invoke-throws " + e.getCause());
        }
        try {
            c.getMethod("nope");
        } catch (NoSuchMethodException e) {
            System.out.println("nsme " + e.getMessage());
        }

        Constructor<?> ctor = c.getConstructor(String.class, int.class);
        Object t2 = ctor.newInstance("made", 5);
        System.out.println("ctor " + ((Target) t2).label + " " + ((Target) t2).secret());

        Field secret = c.getDeclaredField("secret");
        secret.setAccessible(true);
        secret.set(t2, 77);
        System.out.println("field-set " + ((Target) t2).secret() + " " + secret.getInt(t2) + " " + Modifier.toString(secret.getModifiers()));
        Field label = c.getField("label");
        label.set(t2, "relabeled");
        System.out.println("field-pub " + label.get(t2));

        Greeter g = (Greeter) Proxy.newProxyInstance(Reflect.class.getClassLoader(), new Class<?>[] {Greeter.class}, new InvocationHandler() {
            public Object invoke(Object proxy, Method m, Object[] a) {
                if (m.getName().equals("greet")) return "hello " + a[0];
                if (m.getName().equals("twice")) return Integer.valueOf(((Integer) a[0]) * 2);
                return null;
            }
        });
        System.out.println("proxy " + g.greet("bob") + " " + g.twice(21) + " " + Proxy.isProxyClass(g.getClass()) + " " + (g instanceof Greeter));

        System.out.println("array-names " + int[].class.getName() + " " + String[][].class.getName() + " " + Object[].class.getName() + " " + long[].class.getSimpleName());
        System.out.println("array-class " + new int[0].getClass().isArray() + " " + String[].class.getComponentType().getName() + " " + int.class.isPrimitive());
        Object arr = java.lang.reflect.Array.newInstance(int.class, 3);
        java.lang.reflect.Array.setInt(arr, 1, 9);
        System.out.println("array-reflect " + java.lang.reflect.Array.getLength(arr) + " " + java.lang.reflect.Array.get(arr, 1));
        System.out.println("assignable " + Number.class.isAssignableFrom(Integer.class) + " " + Integer.class.isAssignableFrom(Number.class) + " " + Greeter.class.isInterface());
        System.out.println("instanceof " + Target.class.isInstance(t) + " " + c.isInstance("s"));
        System.out.println("prims " + int.class.getName() + " " + Integer.TYPE + " " + void.class);
    }
}
