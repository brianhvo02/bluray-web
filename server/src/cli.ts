import { existsSync } from 'node:fs';
import qrcode from 'qrcode-generator';
import { Auth } from './auth';
import { formatCode, pairingLink } from './codes';
import type { CodeRegistrar } from './codes';
import { RendezvousClient } from './rendezvous-client';
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
  links: { appUrl: string; publicBase: string; rendezvousUrl: string | undefined; registrar?: CodeRegistrar },
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
  const link = pairingLink(code, links);
  print(`Owner pairing code: ${formatCode(code)}`);
  print(`Pairing link: ${link}`);
  print(`Expires: ${new Date(record.expiresAt).toLocaleString('sv-SE')} (single use, 10 minutes)`);
  print(`Person: ${person.name}`);
  print('');
  print(terminalQr(link));
  const rendezvous = links.registrar;
  if (!rendezvous) {
    print('Rendezvous: not configured (RENDEZVOUS_URL is unset)');
    return;
  }
  try {
    await rendezvous.registerCode(record.hash, { https: links.publicBase }, record.expiresAt);
    print('Rendezvous: registered');
  } catch (err) {
    print(`Rendezvous: not registered (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * `node server.mjs nas-id`: prints this NAS's rendezvous id (its key's thumbprint), the id the owner puts on the
 * Worker's `TURN_NAS_IDS` allowlist so the relay can mint for it. Makes no key: before the server has run with
 * `RENDEZVOUS_URL` there is none, and it says so. Gives the id, or null.
 */
export async function printNasId(keyFile: string, print: (line: string) => void = console.log): Promise<string | null> {
  if (!existsSync(keyFile)) {
    print(`No rendezvous key yet (${keyFile}): start the server with RENDEZVOUS_URL set first.`);
    return null;
  }
  const nasId = await new RendezvousClient('https://rendezvous.invalid/', keyFile).localNasId();
  print(`NAS id: ${nasId}`);
  print('For the relay, add it to the rendezvous Worker\'s allowlist: npx wrangler secret put TURN_NAS_IDS (comma-separated ids).');
  return nasId;
}
