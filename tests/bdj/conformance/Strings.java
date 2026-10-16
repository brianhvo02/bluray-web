package conformance;

public class Strings {
    public static void main(String[] args) throws Exception {
        StringBuilder sb = new StringBuilder();
        sb.append("abc").append(1).append('x').append(2.5).append(true).append((Object) null).append(7L);
        System.out.println("sb " + sb + " " + sb.length());
        sb.insert(0, "<<").reverse();
        System.out.println("sb-rev " + sb);
        sb.setLength(3);
        sb.setCharAt(0, 'Z');
        sb.deleteCharAt(1);
        System.out.println("sb-edit " + sb + " " + sb.indexOf("l"));

        System.out.println("format " + String.format("%5.2f|%x|%s", 3.14159, 255, "hi"));
        System.out.println("format2 " + String.format("%08d|%-6s|%+d|%c|%b|%e", 42, "ab", 5, 'q', true, 12345.678));
        System.out.println("format3 " + String.format("%,d|%o|%10.3e|%%", 1234567, 8, 0.000123));

        String s1 = new String("interned");
        String s2 = "interned";
        System.out.println("intern " + (s1 == s2) + " " + (s1.intern() == s2) + " " + s1.equals(s2));
        String c1 = "con" + "cat";
        System.out.println("constant-fold " + (c1 == "concat"));

        String longStr = "The quick brown fox jumps over the lazy dog, again and again and again.";
        System.out.println("hash " + longStr.hashCode() + " " + "".hashCode() + " " + "a".hashCode());
        System.out.println("split " + java.util.Arrays.toString("a1b22c333d".split("[0-9]+")));
        System.out.println("split2 " + java.util.Arrays.toString("a,b,,c,,".split(",")) + " " + java.util.Arrays.toString("a,b,,c,,".split(",", -1)));
        System.out.println("split3 " + java.util.Arrays.toString("one  two\tthree".split("\\s+")));
        System.out.println("replace " + "aaa".replace("a", "bb") + " " + "x.y.z".replaceAll("\\.", "/") + " " + "hello".replaceFirst("l+", "L"));
        System.out.println("upper-sharp-s " + "stra\u00dfe".toUpperCase() + " " + "STRA\u00dfE".toLowerCase());
        System.out.println("upper-i " + "title".toUpperCase(java.util.Locale.ENGLISH));

        String jp = "\u65e5\u672c\u8a9e";
        byte[] utf8 = jp.getBytes("UTF-8");
        System.out.println("utf8 " + jp.length() + " " + utf8.length + " " + new String(utf8, "UTF-8").equals(jp));
        byte[] utf16 = jp.getBytes("UTF-16BE");
        System.out.println("utf16 " + utf16.length + " " + (utf16[0] & 0xff) + " " + (utf16[1] & 0xff));
        byte[] latin = "caf\u00e9".getBytes("ISO-8859-1");
        System.out.println("latin1 " + latin.length + " " + (latin[3] & 0xff));
        StringBuilder hex = new StringBuilder();
        for (int i = 0; i < utf8.length; i++) hex.append(Integer.toHexString(utf8[i] & 0xff));
        System.out.println("utf8-hex " + hex);
        System.out.println("surrogate " + "\ud83d\ude00".length() + " " + "\ud83d\ude00".codePointAt(0) + " " + "\ud83d\ude00".getBytes("UTF-8").length);

        char[] cs = {'h', 'e', 'l', 'l', 'o'};
        System.out.println("valueOf-chars " + String.valueOf(cs) + " " + String.valueOf(cs, 1, 3) + " " + String.valueOf(3.0f) + " " + String.valueOf((Object) null));
        System.out.println("misc " + "  trim me ".trim() + "|" + "abc".indexOf('c') + "|" + "abcabc".lastIndexOf("bc") + "|" + "abc".compareTo("abd") + "|" + "Abc".equalsIgnoreCase("aBC") + "|" + "abc".contains("bc"));
        System.out.println("chars " + "abc".charAt(1) + " " + (int) "abc".charAt(1) + " " + Character.isDigit('5') + " " + (int) Character.toUpperCase('\u00e9') + " " + Character.isLetter('\u65e5'));
        System.out.println("join " + String.join("-", "a", "b", "c"));
        System.out.println("regex " + "2026-10-15".matches("\\d{4}-\\d{2}-\\d{2}"));
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("(\\w+)@(\\w+)\\.com").matcher("mail bob@example.com now");
        System.out.println("matcher " + m.find() + " " + m.group(1) + " " + m.group(2) + " " + m.start());
        System.out.println("parse " + Integer.parseInt("-123") + " " + Integer.valueOf("7f", 16) + " " + Double.parseDouble("1e3") + " " + Integer.toString(255, 2));
        System.out.println("concat-types " + 1 + 2 + 'c' + 1.5f + null + true);
        System.out.println("compare-ignore " + "b".compareToIgnoreCase("A"));
        System.out.println("tochararray " + new String("xyz".toCharArray(), 1, 2));
    }
}
