package conformance;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.net.URLConnection;

// BD-Live with no network, as the libbluray harness runs it (docker --network none): every attempt fails with an
// IOException and the program carries on. Only the exception's class is printed; messages are the platform's own.
public class Net {
    interface Attempt {
        Object run() throws Exception;
    }

    static void attempt(String what, Attempt a) {
        try {
            Object r = a.run();
            System.out.println(what + " returned " + r);
        } catch (IOException e) {
            System.out.println(what + " " + e.getClass().getName());
        } catch (Exception e) {
            System.out.println(what + " other " + e.getClass().getName());
        }
    }

    public static void main(String[] args) throws Exception {
        attempt("lookup-name", new Attempt() {
            public Object run() throws Exception { return InetAddress.getByName("bdlive.example"); }
        });
        attempt("lookup-all", new Attempt() {
            public Object run() throws Exception { return Integer.valueOf(InetAddress.getAllByName("bdlive.example").length); }
        });
        attempt("lookup-literal", new Attempt() {
            public Object run() throws Exception { return InetAddress.getByName("192.0.2.1").getHostAddress(); }
        });
        attempt("http-name-stream", new Attempt() {
            public Object run() throws Exception {
                InputStream in = new URL("http://bdlive.example/x").openConnection().getInputStream();
                return Integer.valueOf(in.read());
            }
        });
        attempt("http-name-code", new Attempt() {
            public Object run() throws Exception {
                HttpURLConnection c = (HttpURLConnection) new URL("http://bdlive.example/check.xml?disc=1").openConnection();
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setConnectTimeout(5000);
                c.setReadTimeout(5000);
                return Integer.valueOf(c.getResponseCode());
            }
        });
        attempt("http-name-connect", new Attempt() {
            public Object run() throws Exception {
                URLConnection c = new URL("http://bdlive.example:8080/x").openConnection();
                c.connect();
                return "connected";
            }
        });
        attempt("http-address-stream", new Attempt() {
            public Object run() throws Exception {
                return Integer.valueOf(new URL("http://192.0.2.1/x").openStream().read());
            }
        });
        attempt("socket-name", new Attempt() {
            public Object run() throws Exception { return new Socket("bdlive.example", 80); }
        });
        attempt("socket-address", new Attempt() {
            public Object run() throws Exception { return new Socket("192.0.2.1", 80); }
        });
        attempt("socket-address-timeout", new Attempt() {
            public Object run() throws Exception {
                Socket s = new Socket();
                try {
                    s.connect(new InetSocketAddress("192.0.2.1", 443), 5000);
                    return "connected";
                } finally {
                    s.close();
                }
            }
        });
        attempt("socket-unresolved", new Attempt() {
            public Object run() throws Exception {
                Socket s = new Socket();
                try {
                    s.connect(new InetSocketAddress("bdlive.example", 80), 5000);
                    return "connected";
                } finally {
                    s.close();
                }
            }
        });
        attempt("lookup-localhost", new Attempt() {
            public Object run() throws Exception {
                StringBuilder sb = new StringBuilder();
                InetAddress[] all = InetAddress.getAllByName("localhost");
                for (int i = 0; i < all.length; i++) sb.append(i == 0 ? "" : ",").append(all[i]).append(all[i].isLoopbackAddress() ? "(loopback)" : "");
                return sb.toString();
            }
        });
        attempt("socket-loopback", new Attempt() {
            public Object run() throws Exception { return new Socket("127.0.0.1", 9); }
        });
        attempt("socket-localhost", new Attempt() {
            public Object run() throws Exception { return new Socket("localhost", 9); }
        });
        attempt("http-loopback", new Attempt() {
            public Object run() throws Exception { return Integer.valueOf(new URL("http://127.0.0.1:9/x").openStream().read()); }
        });
        attempt("reverse-address", new Attempt() {
            public Object run() throws Exception { return InetAddress.getByName("192.0.2.1").getHostName(); }
        });
        attempt("reachable-address", new Attempt() {
            public Object run() throws Exception { return Boolean.valueOf(InetAddress.getByName("192.0.2.1").isReachable(1000)); }
        });
        System.out.println("carried on");
    }
}
