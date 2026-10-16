package conformance;

public class Recursion {
    static int depth;

    static void forever() {
        depth++;
        forever();
    }

    static int down(int n) {
        return n == 0 ? 0 : 1 + down(n - 1);
    }

    public static void main(String[] args) {
        try {
            forever();
        } catch (StackOverflowError e) {
            System.out.println("caught " + (depth > 500));
        }
        depth = 0;
        System.out.println("after-overflow " + down(1000));
        try {
            forever();
        } catch (Throwable t) {
            System.out.println("caught-again " + t.getClass().getName());
        }
        System.out.println("depth " + down(1000));
    }
}
