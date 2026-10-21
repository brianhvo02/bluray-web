import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Jvm } from './jvm';
import { byteArray } from './natives/util';
import type { JObject } from './values';
import { Vfs } from './vfs';
import { ZipArchive } from './zip';
import { assembleClass } from '../../../../tests/helpers/jvm-asm';
import type { Const } from '../../../../tests/helpers/jvm-asm';

// Ruling R20: AccessController walks the interpreter's frames. A class defined with a protection domain of its own (as
// libbluray's BDJClassLoader defines an xlet's classes) restricts every check made with it on the stack, unless trusted
// code between it and the check called doPrivileged; doPrivileged by the restricted class itself still counts it.

const jar = (rel: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
const RT = jar('../../../bdj-classlib/rt-bdj.jar');

const NEW = 0xbb, DUP = 0x59, LDC_W = 0x13, ACONST_NULL = 0x01, ICONST_0 = 0x03, ANEWARRAY = 0xbd, ARRAYLENGTH = 0xbe;
const ALOAD_0 = 0x2a, ALOAD_1 = 0x2b, ALOAD_2 = 0x2c, ARETURN = 0xb0, RETURN = 0xb1, ATHROW = 0xbf;
const INVOKESPECIAL = 0xb7, INVOKESTATIC = 0xb8, INVOKEVIRTUAL = 0xb6;

const c = (k: Const): { c: Const } => ({ c: k });
const m = (owner: string, name: string, desc: string): { c: Const } => c(['method', owner, name, desc]);
const str = (s: string): { c: Const } => c(['string', s]);
const cls = (n: string): { c: Const } => c(['class', n]);

/** Trusted helpers on the boot class path (no protection domain). */
const PROBE = assembleClass('AccessProbe', [
  {
    // new ProtectionDomain(new CodeSource(new URL("file:/untrusted/"), null), null, null, null): permissions from the policy
    name: 'domain',
    desc: '()Ljava/security/ProtectionDomain;',
    code: [
      NEW, cls('java/security/ProtectionDomain'), DUP,
      NEW, cls('java/security/CodeSource'), DUP,
      NEW, cls('java/net/URL'), DUP, LDC_W, str('file:/untrusted/'), INVOKESPECIAL, m('java/net/URL', '<init>', '(Ljava/lang/String;)V'),
      ACONST_NULL, INVOKESPECIAL, m('java/security/CodeSource', '<init>', '(Ljava/net/URL;[Ljava/security/cert/Certificate;)V'),
      ACONST_NULL, ACONST_NULL, ACONST_NULL,
      INVOKESPECIAL, m('java/security/ProtectionDomain', '<init>', '(Ljava/security/CodeSource;Ljava/security/PermissionCollection;Ljava/lang/ClassLoader;[Ljava/security/Principal;)V'),
      ARETURN,
    ],
  },
  {
    name: 'define',
    desc: '(Ljava/lang/ClassLoader;[BLjava/security/ProtectionDomain;)Ljava/lang/Class;',
    code: [
      INVOKESTATIC, m('sun/misc/Unsafe', 'getUnsafe', '()Lsun/misc/Unsafe;'),
      LDC_W, str('Untrusted'), ALOAD_1, ICONST_0, ALOAD_1, ARRAYLENGTH, ALOAD_0, ALOAD_2,
      INVOKEVIRTUAL, m('sun/misc/Unsafe', 'defineClass', '(Ljava/lang/String;[BIILjava/lang/ClassLoader;Ljava/security/ProtectionDomain;)Ljava/lang/Class;'),
      ARETURN,
    ],
  },
  {
    name: 'install',
    desc: '()V',
    code: [NEW, cls('java/lang/SecurityManager'), DUP, INVOKESPECIAL, m('java/lang/SecurityManager', '<init>', '()V'), INVOKESTATIC, m('java/lang/System', 'setSecurityManager', '(Ljava/lang/SecurityManager;)V'), RETURN],
  },
  {
    // trusted library code reading a property for its caller, inside doPrivileged
    name: 'readPrivileged',
    desc: '(Ljava/lang/String;)Ljava/lang/Object;',
    code: [
      NEW, cls('sun/security/action/GetPropertyAction'), DUP, ALOAD_0, INVOKESPECIAL, m('sun/security/action/GetPropertyAction', '<init>', '(Ljava/lang/String;)V'),
      INVOKESTATIC, m('java/security/AccessController', 'doPrivileged', '(Ljava/security/PrivilegedAction;)Ljava/lang/Object;'),
      ARETURN,
    ],
  },
  {
    // c.getMethod(name).invoke(null), rethrowing what the method threw
    name: 'call',
    desc: '(Ljava/lang/Class;Ljava/lang/String;)Ljava/lang/Object;',
    code: [
      ALOAD_0, ALOAD_1, ICONST_0, ANEWARRAY, cls('java/lang/Class'), // 0
      INVOKEVIRTUAL, m('java/lang/Class', 'getMethod', '(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;'), // 6
      ACONST_NULL, ICONST_0, ANEWARRAY, cls('java/lang/Object'), // 9
      INVOKEVIRTUAL, m('java/lang/reflect/Method', 'invoke', '(Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;'), // 14
      ARETURN, // 17
      INVOKEVIRTUAL, m('java/lang/Throwable', 'getCause', '()Ljava/lang/Throwable;'), ATHROW, // 18
    ],
    handlers: [[0, 17, 18, 'java/lang/reflect/InvocationTargetException']],
  },
]);

/** The restricted class (defined with AccessProbe.domain()). */
const UNTRUSTED = assembleClass('Untrusted', [
  { name: 'direct', desc: '()Ljava/lang/Object;', code: [LDC_W, str('user.home'), INVOKESTATIC, m('java/lang/System', 'getProperty', '(Ljava/lang/String;)Ljava/lang/String;'), ARETURN] },
  { name: 'granted', desc: '()Ljava/lang/Object;', code: [LDC_W, str('java.version'), INVOKESTATIC, m('java/lang/System', 'getProperty', '(Ljava/lang/String;)Ljava/lang/String;'), ARETURN] },
  { name: 'viaTrusted', desc: '()Ljava/lang/Object;', code: [LDC_W, str('user.home'), INVOKESTATIC, m('AccessProbe', 'readPrivileged', '(Ljava/lang/String;)Ljava/lang/Object;'), ARETURN] },
  {
    // its own action (a class of its own: a JDK action class in sun.* is itself out of bounds for it)
    name: 'ownPrivileged',
    desc: '()Ljava/lang/Object;',
    code: [
      NEW, cls('Untrusted'), DUP, INVOKESPECIAL, m('Untrusted', '<init>', '()V'),
      INVOKESTATIC, m('java/security/AccessController', 'doPrivileged', '(Ljava/security/PrivilegedAction;)Ljava/lang/Object;'),
      ARETURN,
    ],
  },
  { name: '<init>', desc: '()V', access: 0x0001, code: [ALOAD_0, INVOKESPECIAL, m('java/lang/Object', '<init>', '()V'), RETURN] },
  { name: 'run', desc: '()Ljava/lang/Object;', access: 0x0001, code: [LDC_W, str('user.home'), INVOKESTATIC, m('java/lang/System', 'getProperty', '(Ljava/lang/String;)Ljava/lang/String;'), ARETURN] },
], [], 'java/lang/Object', { interfaces: ['java/security/PrivilegedAction'] });

describe('access control over the interpreter stack (Ruling R20)', () => {
  let jvm: Jvm;
  let untrusted: JObject;
  const call = (name: string): Promise<unknown> => jvm.callStatic('AccessProbe', 'call', '(Ljava/lang/Class;Ljava/lang/String;)Ljava/lang/Object;', [untrusted, jvm.heap.newString(name)]);

  beforeAll(async () => {
    jvm = new Jvm({
      bootJars: [RT],
      nowMs: () => Date.now(),
      setTimer: (ms, fn) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      stdout: () => {},
      stderr: () => {},
      vfs: new Vfs({ disc: null, jdkLib: ZipArchive.open(RT), nowMs: () => Date.now() }),
    });
    await jvm.boot();
    jvm.loader.define('AccessProbe', PROBE, null, null);
    const loader = (await jvm.callStatic('java/lang/ClassLoader', 'getSystemClassLoader', '()Ljava/lang/ClassLoader;')) as JObject;
    const domain = (await jvm.callStatic('AccessProbe', 'domain', '()Ljava/security/ProtectionDomain;')) as JObject;
    untrusted = (await jvm.callStatic('AccessProbe', 'define', '(Ljava/lang/ClassLoader;[BLjava/security/ProtectionDomain;)Ljava/lang/Class;', [loader, byteArray(jvm, UNTRUSTED), domain])) as JObject;
    await jvm.callStatic('AccessProbe', 'install', '()V');
  }, 60_000);

  it('denies a restricted class a property the policy does not grant', async () => {
    await expect(call('direct')).rejects.toThrow('java.security.AccessControlException: access denied ("java.util.PropertyPermission" "user.home" "read")');
  });

  it("grants what the JDK's policy file grants everyone", async () => {
    expect(jvm.heap.jsString((await call('granted')) as JObject)).toMatch(/^1\.8/);
  });

  it('lets trusted code read for it inside doPrivileged: the walk stops at that frame', async () => {
    expect(await call('viaTrusted')).not.toBeNull();
  });

  it("still counts the restricted class when it calls doPrivileged itself: the privileged frame's domain is its own", async () => {
    await expect(call('ownPrivileged')).rejects.toThrow('java.security.AccessControlException: access denied ("java.util.PropertyPermission" "user.home" "read")');
  });

  it('leaves code with no restricted frame on the stack unchecked', async () => {
    expect(await jvm.callStatic('AccessProbe', 'readPrivileged', '(Ljava/lang/String;)Ljava/lang/Object;', [jvm.heap.newString('user.home')])).not.toBeUndefined();
    const v = await jvm.callStatic('java/lang/System', 'getProperty', '(Ljava/lang/String;)Ljava/lang/String;', [jvm.heap.newString('user.home')]);
    expect(v).not.toBeUndefined();
  });
});
