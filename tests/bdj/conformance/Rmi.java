package conformance;

import java.rmi.registry.Registry;

// java.rmi.registry.Registry loads, as an interface, with its constant (some discs' code names it).
public class Rmi {
    public static void main(String[] args) throws Exception {
        Class<?> c = Class.forName("java.rmi.registry.Registry");
        System.out.println("registry " + c.getName() + " interface " + c.isInterface() + " port " + Registry.REGISTRY_PORT);
        Class<?>[] supers = c.getInterfaces();
        System.out.println("extends " + supers.length + " " + supers[0].getName());
        System.out.println("methods " + c.getMethods().length);
        System.out.println("remote-exception " + new java.rmi.RemoteException("gone").getMessage());
    }
}
