import { describe, expect, it } from 'vitest';
import { NasHttpError, type NasPerson } from './nas-client';
import { adminFailure, rendezvousNotice, loseSettingsMessage, losesNasSettings, codeSummary, codeTarget, formatSize, lastOwnerMessage, moveTargets, pairedAs, personRows, removePersonQuestion } from './people-model';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const MB = 1024 * 1024;

const person = (over: Partial<NasPerson> = {}): NasPerson => ({
  id: 'p1',
  name: 'Mika',
  owner: false,
  createdAt: NOW - DAY,
  savedBytes: 0,
  devices: [],
  ...over,
});

describe('formatSize', () => {
  it('says none for nothing, and a short size otherwise', () => {
    expect(formatSize(0)).toBe('none');
    expect(formatSize(512)).toBe('512 bytes');
    expect(formatSize(1)).toBe('1 byte');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(1.2 * MB)).toBe('1.2 MB');
    expect(formatSize(16 * MB)).toBe('16 MB');
    expect(formatSize(256 * MB)).toBe('256 MB');
    expect(formatSize(3 * 1024 * MB)).toBe('3 GB');
  });
});

describe('personRows', () => {
  const owner = person({
    id: 'p0',
    name: 'Owner',
    owner: true,
    savedBytes: 1.2 * MB,
    devices: [
      { id: 'd1', name: 'Mac Safari', pairedAt: NOW - DAY, lastSeen: NOW - 5 * MINUTE, lastRoute: 'relay' },
      { id: 'd2', name: 'iPad', pairedAt: NOW - DAY, lastSeen: NOW - 2 * HOUR, lastRoute: 'https' },
    ],
  });

  it('gives each person a name, an owner badge, device lines with last seen, and the saved data', () => {
    expect(personRows([owner, person()], NOW, 'd1')).toEqual([
      {
        id: 'p0',
        name: 'Owner',
        owner: true,
        badge: 'Owner',
        devices: [
          { id: 'd1', text: 'Mac Safari (this device) · last seen 5 minutes ago', route: 'WebRTC (relayed)', thisDevice: true },
          { id: 'd2', text: 'iPad · last seen 2 hours ago', route: 'Home or Tailscale', thisDevice: false },
        ],
        noDevices: null,
        saved: 'Saved data: 1.2 MB',
        canClearSaved: true,
      },
      { id: 'p1', name: 'Mika', owner: false, badge: null, devices: [], noDevices: 'No devices yet', saved: 'Saved data: none', canClearSaved: false },
    ]);
  });

  it('lists owners first, then A–Z', () => {
    const rows = personRows([person({ id: 'a', name: 'sora' }), person({ id: 'b', name: 'Mika' }), person({ id: 'c', name: 'Zed', owner: true })], NOW, null);
    expect(rows.map((r) => r.name)).toEqual(['Zed', 'Mika', 'sora']);
  });
});

describe('removePersonQuestion', () => {
  it('names the devices and the saved data that go', () => {
    const p = person({
      savedBytes: 1.2 * MB,
      devices: [
        { id: 'd1', name: 'iPad', pairedAt: 0, lastSeen: 0 },
        { id: 'd2', name: 'iPhone', pairedAt: 0, lastSeen: 0 },
      ],
    });
    expect(removePersonQuestion(p)).toBe('Remove Mika? Their 2 devices (iPad, iPhone) are unpaired, and 1.2 MB of saved data is deleted.');
  });

  it('marks this device among them', () => {
    const p = person({ devices: [{ id: 'me', name: 'iPad', pairedAt: 0, lastSeen: 0 }] });
    expect(removePersonQuestion(p, 'me')).toBe('Remove Mika? Their device iPad (this device) is unpaired.');
    expect(removePersonQuestion(p, 'other')).toBe('Remove Mika? Their device iPad is unpaired.');
  });

  it('names one device, or none, and leaves out saved data there is none of', () => {
    const one = person({ devices: [{ id: 'd1', name: 'iPad', pairedAt: 0, lastSeen: 0 }] });
    expect(removePersonQuestion(one)).toBe('Remove Mika? Their device iPad is unpaired.');
    expect(removePersonQuestion(person({ savedBytes: 2048 }))).toBe('Remove Mika? 2 KB of saved data is deleted.');
    expect(removePersonQuestion(person())).toBe('Remove Mika? They have no devices and no saved data.');
  });
});

describe('lastOwnerMessage', () => {
  it('says an owner device has to stay', () => {
    expect(lastOwnerMessage).toBe('At least one owner device has to stay. Make someone else an owner first.');
  });

  it('is what a 409 last-owner reads as; other failures keep their message', () => {
    expect(adminFailure(new NasHttpError(409, 'last-owner'))).toBe(lastOwnerMessage);
    expect(adminFailure(new NasHttpError(404, 'unknown person'))).toBe('The NAS answered 404 (unknown person).');
    expect(adminFailure('boom')).toBe('boom');
  });
});

describe('codeTarget', () => {
  it('makes a code for an existing person', () => {
    expect(codeTarget('p1', '', false)).toEqual({ target: { personId: 'p1' } });
  });

  it('makes a code for a new person, trimmed, who may be an owner', () => {
    expect(codeTarget('new', '  Mika ', false)).toEqual({ target: { newPerson: { name: 'Mika', owner: false } } });
    expect(codeTarget('new', 'Sora', true)).toEqual({ target: { newPerson: { name: 'Sora', owner: true } } });
  });

  it('asks for a name of 1 to 100 characters', () => {
    expect(codeTarget('new', '  ', false)).toEqual({ error: 'Give the new person a name.' });
    expect(codeTarget('new', 'x'.repeat(101), false)).toEqual({ error: 'A name is at most 100 characters.' });
  });
});

describe('the code view', () => {
  it('says who the code is for and how long it lasts', () => {
    expect(codeSummary('Mika', false)).toBe('For Mika · valid 10 minutes');
    expect(codeSummary('Mika', true)).toBe('For Mika · an invite, valid 3 days');
  });
});

describe('rendezvousNotice', () => {
  it("says a code the pairing service didn't take only works at home or over Tailscale", () => {
    expect(rendezvousNotice(true)).toBeNull();
    expect(rendezvousNotice(false)).toBe(
      "The pairing service didn't take this code, so it only works on your home network or over Tailscale. Try again later for a friend away from home.",
    );
  });
});

describe('moveTargets', () => {
  it('offers every other person', () => {
    const people = [person({ id: 'p0', name: 'Owner', owner: true }), person(), person({ id: 'p2', name: 'Sora' })];
    expect(moveTargets(people, 'p1')).toEqual([
      { id: 'p0', name: 'Owner' },
      { id: 'p2', name: 'Sora' },
    ]);
  });
});

describe('pairedAs', () => {
  it("names the device's person, or the device for a pairing stored before people", () => {
    expect(pairedAs({ personName: 'Mika', deviceName: 'iPad' })).toBe('Paired as Mika.');
    expect(pairedAs({ deviceName: 'iPad' })).toBe('Paired with the NAS as iPad.');
  });
});

describe('losesNasSettings', () => {
  const people = [
    person({ id: 'p0', name: 'Owner', owner: true, devices: [{ id: 'me', name: 'Mac', pairedAt: 0, lastSeen: 0 }, { id: 'd2', name: 'iPad', pairedAt: 0, lastSeen: 0 }] }),
    person({ id: 'p2', name: 'Ren', owner: true }),
    person({ devices: [{ id: 'd3', name: 'iPhone', pairedAt: 0, lastSeen: 0 }] }),
  ];

  it("is true for removing owner from this device's person, or moving this device to someone who isn't an owner", () => {
    expect(losesNasSettings(people, 'me', { kind: 'remove-owner', personId: 'p0' })).toBe(true);
    expect(losesNasSettings(people, 'me', { kind: 'move', deviceId: 'me', toPersonId: 'p1' })).toBe(true);
  });

  it('is false for other people, other devices, a move to another owner, or an unknown device', () => {
    expect(losesNasSettings(people, 'me', { kind: 'remove-owner', personId: 'p2' })).toBe(false);
    expect(losesNasSettings(people, 'me', { kind: 'move', deviceId: 'd2', toPersonId: 'p1' })).toBe(false);
    expect(losesNasSettings(people, 'me', { kind: 'move', deviceId: 'me', toPersonId: 'p2' })).toBe(false);
    expect(losesNasSettings(people, null, { kind: 'remove-owner', personId: 'p0' })).toBe(false);
    expect(losesNasSettings(people, 'd3', { kind: 'move', deviceId: 'd3', toPersonId: 'p0' })).toBe(false);
  });

  it('asks in words', () => {
    expect(loseSettingsMessage).toBe('This device will lose NAS settings. Only another owner can give them back.');
  });
});
