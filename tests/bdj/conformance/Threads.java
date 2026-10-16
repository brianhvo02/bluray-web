package conformance;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public class Threads {
    static int counter;
    static final Object lock = new Object();
    static boolean ready;
    static int handoff;

    static void inc() {
        for (int i = 0; i < 10000; i++) {
            synchronized (lock) {
                counter++;
            }
        }
    }

    public static void main(String[] args) throws Exception {
        System.out.println("main-name " + Thread.currentThread().getName());

        Thread a = new Thread(new Runnable() { public void run() { inc(); } }, "worker-a");
        Thread b = new Thread(new Runnable() { public void run() { inc(); } }, "worker-b");
        a.start();
        b.start();
        a.join();
        b.join();
        System.out.println("counter " + counter);
        System.out.println("alive-after-join " + a.isAlive() + " " + b.isAlive());

        Thread waiter = new Thread(new Runnable() {
            public void run() {
                synchronized (lock) {
                    while (!ready) {
                        try {
                            lock.wait();
                        } catch (InterruptedException e) {
                            return;
                        }
                    }
                    handoff = 99;
                    lock.notifyAll();
                }
            }
        });
        waiter.start();
        synchronized (lock) {
            ready = true;
            lock.notifyAll();
            while (handoff == 0) lock.wait();
        }
        waiter.join();
        System.out.println("handoff " + handoff);

        final Thread sleeper = new Thread(new Runnable() {
            public void run() {
                try {
                    Thread.sleep(60000);
                    System.out.println("sleeper woke normally");
                } catch (InterruptedException e) {
                    System.out.println("sleeper " + e.getClass().getSimpleName() + " flag=" + Thread.currentThread().isInterrupted());
                }
            }
        });
        sleeper.start();
        while (sleeper.getState() != Thread.State.TIMED_WAITING) Thread.yield();
        sleeper.interrupt();
        sleeper.join();

        Thread.currentThread().interrupt();
        System.out.println("interrupted-flag " + Thread.interrupted() + " " + Thread.interrupted());

        final CountDownLatch latch = new CountDownLatch(3);
        final int[] done = new int[1];
        for (int i = 0; i < 3; i++) {
            new Thread(new Runnable() {
                public void run() {
                    synchronized (done) { done[0]++; }
                    latch.countDown();
                }
            }).start();
        }
        latch.await();
        System.out.println("latch " + latch.getCount() + " " + done[0]);

        ExecutorService ex = Executors.newFixedThreadPool(2);
        Future<Integer> f1 = ex.submit(new java.util.concurrent.Callable<Integer>() {
            public Integer call() { return 20; }
        });
        Future<Integer> f2 = ex.submit(new java.util.concurrent.Callable<Integer>() {
            public Integer call() { return 22; }
        });
        System.out.println("executor " + (f1.get() + f2.get()));
        ex.shutdown();
        System.out.println("terminated " + ex.awaitTermination(30, java.util.concurrent.TimeUnit.SECONDS));

        ThreadLocal<Integer> tl = new ThreadLocal<Integer>() {
            protected Integer initialValue() { return 5; }
        };
        tl.set(6);
        final int[] other = new int[1];
        final ThreadLocal<Integer> tl2 = tl;
        Thread t = new Thread(new Runnable() { public void run() { other[0] = tl2.get(); } });
        t.start();
        t.join();
        System.out.println("threadlocal " + tl.get() + " " + other[0]);

        Thread daemon = new Thread(new Runnable() {
            public void run() {
                while (true) {
                    try {
                        Thread.sleep(1000);
                    } catch (InterruptedException e) {
                        return;
                    }
                }
            }
        }, "daemon");
        daemon.setDaemon(true);
        daemon.start();
        System.out.println("daemon " + daemon.isDaemon() + " " + daemon.isAlive());
        System.out.println("end");
    }
}
