package conformance;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Hashtable;
import java.util.Iterator;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.TreeMap;
import java.util.Vector;

// The class name shadows java.util.Collections, so that one is always qualified.
public class Collections {
    public static void main(String[] args) throws Exception {
        Map<Integer, String> hm = new HashMap<Integer, String>();
        for (int i = 0; i < 100; i++) hm.put(i * 37 % 101, "v" + i);
        List<Integer> keys = new ArrayList<Integer>(hm.keySet());
        java.util.Collections.sort(keys);
        long ksum = 0;
        for (Integer k : keys) ksum += k;
        System.out.println("hashmap " + hm.size() + " " + keys.get(0) + " " + keys.get(99) + " " + ksum);
        System.out.println("hashmap-get " + hm.get(37) + " " + hm.get(1000) + " " + hm.containsKey(74) + " " + hm.remove(37) + " " + hm.size());
        System.out.println("hashmap-null " + new HashMap<String, String>() {{ put(null, "n"); }}.get(null));
        System.out.println("keys-head " + keys.subList(0, 8));

        TreeMap<String, Integer> tm = new TreeMap<String, Integer>();
        String[] words = {"pear", "apple", "fig", "banana", "cherry"};
        for (int i = 0; i < words.length; i++) tm.put(words[i], i);
        System.out.println("treemap " + tm + " " + tm.firstKey() + " " + tm.lastKey());
        System.out.println("treemap-nav " + tm.headMap("cherry") + " " + tm.ceilingKey("c") + " " + tm.floorKey("c") + " " + tm.descendingMap());
        TreeMap<String, Integer> rev = new TreeMap<String, Integer>(java.util.Collections.<String>reverseOrder());
        rev.putAll(tm);
        System.out.println("treemap-rev " + rev.keySet());

        List<String> al = new ArrayList<String>();
        for (String w : words) al.add(w);
        al.add(1, "kiwi");
        al.remove("fig");
        System.out.println("arraylist " + al + " " + al.indexOf("pear") + " " + al.contains("fig"));
        LinkedList<Integer> ll = new LinkedList<Integer>();
        ll.add(2);
        ll.addFirst(1);
        ll.addLast(3);
        ll.removeFirst();
        System.out.println("linkedlist " + ll + " " + ll.peekFirst() + " " + ll.getLast());
        Vector<Integer> v = new Vector<Integer>();
        v.addElement(10);
        v.add(20);
        v.insertElementAt(5, 0);
        System.out.println("vector " + v + " " + v.elementAt(1) + " " + v.size());
        Hashtable<String, Integer> ht = new Hashtable<String, Integer>();
        ht.put("one", 1);
        ht.put("two", 2);
        ht.put("three", 3);
        List<String> htkeys = new ArrayList<String>(ht.keySet());
        java.util.Collections.sort(htkeys);
        System.out.println("hashtable " + htkeys + " " + ht.get("two") + " " + ht.containsKey("four"));
        try {
            ht.put("x", null);
        } catch (NullPointerException e) {
            System.out.println("hashtable-null NPE");
        }

        List<String> sorted = new ArrayList<String>();
        for (String w : words) sorted.add(w);
        java.util.Collections.sort(sorted, new Comparator<String>() {
            public int compare(String a, String b) {
                int d = a.length() - b.length();
                return d != 0 ? d : b.compareTo(a);
            }
        });
        System.out.println("sort-cmp " + sorted);
        java.util.Collections.reverse(sorted);
        System.out.println("reverse " + sorted + " " + java.util.Collections.max(sorted) + " " + java.util.Collections.min(sorted));
        List<Integer> nums = new ArrayList<Integer>();
        for (int i = 0; i < 10; i++) nums.add(i);
        java.util.Collections.shuffle(nums, new java.util.Random(42));
        System.out.println("shuffle " + nums);
        System.out.println("random " + new java.util.Random(7).nextInt(1000) + " " + new java.util.Random(7).nextLong());

        Iterator<Integer> it = nums.iterator();
        while (it.hasNext()) if (it.next() % 2 == 0) it.remove();
        System.out.println("iter-remove " + nums);
        try {
            for (Integer n : nums) nums.add(n);
        } catch (java.util.ConcurrentModificationException e) {
            System.out.println("cme");
        }
        System.out.println("unmodifiable " + tryModify(java.util.Collections.unmodifiableList(nums)));

        Properties p = new Properties();
        p.load(new java.io.StringReader("# comment\nalpha=1\nbeta : two words\ngamma\\ key=3\n! other\nmulti=a\\\n    b\nuni=\\u00e9\n"));
        List<String> pk = new ArrayList<String>();
        for (Object k : p.keySet()) pk.add((String) k);
        java.util.Collections.sort(pk);
        for (String k : pk) System.out.println("prop " + k + "=" + ascii(p.getProperty(k)));
        System.out.println("prop-default " + p.getProperty("missing", "dflt"));

        java.util.PriorityQueue<Integer> pq = new java.util.PriorityQueue<Integer>();
        pq.add(5);
        pq.add(1);
        pq.add(3);
        System.out.println("pq " + pq.poll() + " " + pq.poll() + " " + pq.poll() + " " + pq.poll());
        java.util.BitSet bs = new java.util.BitSet();
        bs.set(3);
        bs.set(70);
        System.out.println("bitset " + bs + " " + bs.cardinality() + " " + bs.length());
        java.util.LinkedHashMap<String, Integer> lhm = new java.util.LinkedHashMap<String, Integer>();
        lhm.put("z", 1);
        lhm.put("a", 2);
        lhm.put("m", 3);
        System.out.println("linkedhashmap " + lhm);
    }

    static String ascii(String s) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 128) b.append(c); else b.append("\\u").append(Integer.toHexString(c));
        }
        return b.toString();
    }

    static String tryModify(List<Integer> l) {
        try {
            l.add(1);
            return "modified";
        } catch (UnsupportedOperationException e) {
            return "UnsupportedOperationException";
        }
    }
}
