package conformance;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentSkipListMap;
import java.util.concurrent.ThreadLocalRandom;

/**
 * The java.util.concurrent paths that only run when threads race: ConcurrentHashMap's counter cells, which its
 * addCount takes once a compareAndSwap of baseCount loses to another thread and which seed each thread's probe from
 * ThreadLocalRandom, and the skip list's levels, drawn from ThreadLocalRandom on every put.
 */
public class Concurrent {
    static final int THREADS = 4;
    static final int KEYS = 50;
    static final ConcurrentHashMap<Integer, Integer> map = new ConcurrentHashMap<Integer, Integer>();

    public static void main(String[] args) throws Exception {
        Thread[] workers = new Thread[THREADS];
        for (int i = 0; i < THREADS; i++) {
            final int base = i * KEYS;
            workers[i] = new Thread(new Runnable() {
                public void run() {
                    for (int k = 0; k < KEYS; k++) map.putIfAbsent(base + k, k);
                }
            }, "putter-" + i);
        }
        for (Thread t : workers) t.start();
        for (Thread t : workers) t.join();
        long sum = 0;
        for (Integer v : map.values()) sum += v;
        System.out.println("map " + map.size() + " " + map.mappingCount() + " " + sum);

        System.out.println("random " + ThreadLocalRandom.current().nextInt(1) + " " + ThreadLocalRandom.current().nextInt(5, 6));

        ConcurrentSkipListMap<String, Integer> skip = new ConcurrentSkipListMap<String, Integer>();
        String[] words = { "pear", "apple", "fig", "kiwi", "date", "plum" };
        for (int i = 0; i < words.length; i++) skip.put(words[i], i);
        System.out.println("skip " + skip + " first " + skip.firstKey() + " last " + skip.lastKey());
    }
}
