package harness;

import conformance.Bare;

/** Build-time only (not packed into conformance.jar): prints "name value" for each Bare method. */
public class BareMain {
    public static void main(String[] args) {
        System.out.println("sum " + Bare.sum());
        System.out.println("fib " + Bare.fib());
        System.out.println("arrays " + Bare.arrays());
        System.out.println("longs " + Bare.longs());
        System.out.println("fields " + Bare.fields());
        System.out.println("virtual " + Bare.virtual());
        System.out.println("iface " + Bare.iface());
        System.out.println("tableswitch " + Bare.tableswitch());
        System.out.println("lookupswitch " + Bare.lookupswitch());
        System.out.println("catches " + Bare.catches());
    }
}
