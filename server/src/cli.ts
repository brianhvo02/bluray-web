import qrcode from 'qrcode-generator';
import { Auth } from './auth';
import { formatCode, pairingLink } from './codes';
import type { CodeRegistrar } from './codes';
import { Store } from './store';

/** A QR of `text` in half-block characters, light modules drawn, for a dark terminal. */
export function terminalQr(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createASCII(1, 2);
}

/**
 * `node server.mjs owner-code [--person <name>]`: mints one owner pairing code in the running server's data dir
 * and prints it, its pairing link, its expiry, its person and a terminal QR of the link; then registers the code
 * with the rendezvous service, when one is configured, and prints whether that worked. The code is for the first
 * owner person, or with `personName` for the owner person of that name, made when there is none.
 */
export async function ownerCode(
  dataDir: string,
  now: () => number = Date.now,
  print: (line: string) => void = console.log,
  rendezvous?: { registrar: CodeRegistrar; publicBase: string },
  personName?: string,
): Promise<void> {
  const auth = new Auth(new Store(dataDir), now);
  const named = personName?.trim();
  const target = named === undefined
    ? { personId: auth.firstOwnerPerson().id }
    : (() => {
        const found = auth.people().find((p) => p.owner && p.name === named);
        return found ? { personId: found.id } : { newPerson: { name: named, owner: true } };
      })();
  const { code, record, person } = auth.createCode(target);
  const link = pairingLink(code);
  print(`Owner pairing code: ${formatCode(code)}`);
  print(`Pairing link: ${link}`);
  print(`Expires: ${new Date(record.expiresAt).toLocaleString('sv-SE')} (single use, 10 minutes)`);
  print(`Person: ${person.name}`);
  print('');
  print(terminalQr(link));
  if (!rendezvous) {
    print('Rendezvous: not configured (RENDEZVOUS_URL is unset)');
    return;
  }
  try {
    await rendezvous.registrar.registerCode(record.hash, { https: rendezvous.publicBase }, record.expiresAt);
    print('Rendezvous: registered');
  } catch (err) {
    print(`Rendezvous: not registered (${err instanceof Error ? err.message : String(err)})`);
  }
}
