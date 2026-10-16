package conformance;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import java.util.function.Supplier;
import java.util.stream.Collectors;

public class Lambdas {
    interface Named {
        String name();

        default String greeting() { return "hello " + name(); }

        static Named of(final String n) { return () -> n; }
    }

    static String shout(String s) { return s.toUpperCase() + "!"; }

    String prefix = "inst:";

    String tag(String s) { return prefix + s; }

    public static void main(String[] args) {
        final StringBuilder out = new StringBuilder();
        Runnable r = () -> out.append("ran");
        r.run();
        System.out.println("runnable " + out);

        Function<String, String> f = Lambdas::shout;
        System.out.println("static-ref " + f.apply("abc"));
        Lambdas inst = new Lambdas();
        Function<String, String> g = inst::tag;
        System.out.println("bound-ref " + g.apply("x"));
        Function<String, Integer> len = String::length;
        System.out.println("unbound-ref " + len.apply("four"));
        Supplier<List<String>> mk = ArrayList::new;
        List<String> made = mk.get();
        made.add("a");
        System.out.println("ctor-ref " + made);

        List<Integer> nums = new ArrayList<Integer>();
        for (int i = 1; i <= 10; i++) nums.add(i);
        List<String> res = nums.stream().map(i -> i * i).filter(i -> i % 2 == 1).map(i -> "n" + i).collect(Collectors.toList());
        System.out.println("stream " + res);
        System.out.println("stream-sum " + nums.stream().mapToInt(Integer::intValue).sum() + " " + nums.stream().filter(i -> i > 5).count());
        System.out.println("stream-join " + nums.stream().map(String::valueOf).collect(Collectors.joining(",", "[", "]")));
        System.out.println("stream-sorted " + java.util.Arrays.asList("c", "a", "b").stream().sorted(java.util.Comparator.reverseOrder()).collect(Collectors.toList()));

        final int base = 100;
        Function<Integer, Function<Integer, Integer>> adder = a -> b -> a + b + base;
        System.out.println("capture " + adder.apply(1).apply(2));
        int[] counter = {0};
        Runnable incr = () -> counter[0]++;
        incr.run();
        incr.run();
        System.out.println("capture-mutate " + counter[0]);

        Named n = Named.of("world");
        System.out.println("default " + n.greeting());
        Named anon = new Named() {
            public String name() { return "anon"; }

            public String greeting() { return "overridden " + name(); }
        };
        System.out.println("default-override " + anon.greeting());

        System.out.println("join " + String.join(", ", java.util.Arrays.asList("x", "y", "z")) + " " + String.join("/", new String[] {"p", "q"}));
        java.util.Optional<String> opt = java.util.Optional.of("v").map(s -> s + "!");
        System.out.println("optional " + opt.get() + " " + java.util.Optional.empty().isPresent());
        java.util.Map<String, Integer> m = new java.util.TreeMap<String, Integer>();
        m.merge("a", 1, Integer::sum);
        m.merge("a", 5, Integer::sum);
        m.computeIfAbsent("b", k -> 7);
        System.out.println("map-lambda " + m);
        nums.removeIf(i -> i % 3 != 0);
        System.out.println("removeIf " + nums);
        nums.forEach(i -> out.append(i));
        System.out.println("forEach " + out);
    }
}
