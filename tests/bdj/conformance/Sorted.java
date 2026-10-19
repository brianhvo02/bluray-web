package conformance;

import java.util.Comparator;
import java.util.Iterator;
import java.util.NavigableSet;
import java.util.SortedSet;
import java.util.TreeSet;

// java.util.TreeSet: ordering, the navigable views and a comparator.
public class Sorted {
    public static void main(String[] args) throws Exception {
        TreeSet<Integer> s = new TreeSet<Integer>();
        for (int i = 0; i < 40; i++) s.add(i * 17 % 41);
        System.out.println("size " + s.size() + " first " + s.first() + " last " + s.last() + " add-dup " + s.add(17));
        System.out.println("subset " + s.subSet(10, 20));
        System.out.println("subset-incl " + s.subSet(10, false, 20, true));
        System.out.println("head " + s.headSet(5) + " tail " + s.tailSet(36));
        System.out.println("nav " + s.ceiling(0) + " " + s.floor(0) + " " + s.higher(39) + " " + s.lower(1));
        NavigableSet<Integer> d = s.descendingSet().headSet(35, true);
        System.out.println("descending " + d);
        SortedSet<Integer> sub = s.subSet(30, 40);
        sub.remove(31);
        System.out.println("view-remove " + s.contains(31) + " " + sub.size());
        Iterator<Integer> it = s.iterator();
        int removed = 0;
        while (it.hasNext()) if (it.next() % 3 == 0) { it.remove(); removed++; }
        System.out.println("iter-remove " + removed + " " + s.size() + " " + s.pollFirst() + " " + s.pollLast());

        TreeSet<String> w = new TreeSet<String>(new Comparator<String>() {
            public int compare(String a, String b) {
                return a.length() != b.length() ? a.length() - b.length() : a.compareTo(b);
            }
        });
        String[] words = {"chapter", "menu", "audio", "sub", "play", "setup", "extras"};
        for (String x : words) w.add(x);
        System.out.println("comparator " + w + " " + w.first() + " " + w.subSet("play", "chapter"));
        TreeSet<String> copy = new TreeSet<String>(w);
        System.out.println("copy " + copy.equals(w) + " " + (copy.comparator() == w.comparator()) + " " + copy.hashCode());
        try {
            s.subSet(20, 10);
            System.out.println("bad-range accepted");
        } catch (IllegalArgumentException e) {
            System.out.println("bad-range " + e.getMessage());
        }
    }
}
