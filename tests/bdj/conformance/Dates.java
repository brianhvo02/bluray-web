package conformance;

import java.text.DateFormat;
import java.text.FieldPosition;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

// java.text.DateFormat on a fixed date, in UTC (the default locale is en_US in both JVMs).
public class Dates {
    public static void main(String[] args) throws Exception {
        TimeZone utc = TimeZone.getTimeZone("UTC");
        Date when = new Date(1234567890123L);
        DateFormat d = DateFormat.getDateInstance();
        d.setTimeZone(utc);
        System.out.println("date " + d.format(when));
        int[] styles = {DateFormat.SHORT, DateFormat.MEDIUM, DateFormat.LONG, DateFormat.FULL};
        for (int s : styles) {
            DateFormat x = DateFormat.getDateInstance(s, Locale.US);
            x.setTimeZone(utc);
            System.out.println("style " + s + " " + x.format(when));
        }
        DateFormat t = DateFormat.getTimeInstance(DateFormat.SHORT, Locale.US);
        t.setTimeZone(utc);
        System.out.println("time " + t.format(when));
        DateFormat dt = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.MEDIUM, Locale.US);
        dt.setTimeZone(utc);
        System.out.println("datetime " + dt.format(when));
        SimpleDateFormat sdf = new SimpleDateFormat("yyyy/MM/dd HH:mm:ss.SSS EEE", Locale.US);
        sdf.setTimeZone(utc);
        StringBuffer sb = new StringBuffer();
        FieldPosition pos = new FieldPosition(DateFormat.YEAR_FIELD);
        sdf.format(when, sb, pos);
        System.out.println("simple " + sb + " year-at " + pos.getBeginIndex() + "-" + pos.getEndIndex());
        Date back = sdf.parse("2026/10/18 12:34:56.789 Sun");
        System.out.println("parse " + back.getTime());
        Date bad = sdf.parse("not a date", new ParsePosition(0));
        System.out.println("parse-bad " + bad);
        try {
            sdf.parse("nope");
            System.out.println("parse-throw none");
        } catch (java.text.ParseException e) {
            System.out.println("parse-throw " + e.getErrorOffset());
        }
    }
}
