# The owner's cutover to the generic compose file

A one-time runbook for the NAS that ran the previous, hard-coded `compose.yaml` (the one `deploy.sh` wrote before the
compose file became generic). Do the steps in this order. Each one leaves the running service as it was until the
plain deploy in step 6, and every check before it can stop the cutover with nothing changed. A self-hoster who never
ran the previous file skips this page and follows `docs/self-hosting.md`.

Examples use made-up values: the NAS's ssh host `nas.example`, the Caddy site `https://nas.example.com`.

1. **Merge.** CI deploys the site and the rendezvous Worker. The Worker stays open (no `NAS_IDS` yet), so the NAS
   keeps registering and pairing keeps working while the rest is done.

2. **Compare the NAS's live compose file with the repo's previous one.** The migration reads the NAS's file, so it
   should be the file `deploy.sh` last wrote, with no hand edits it can't read:

   ```sh
   git show 5948459:server/deploy/compose.yaml > /tmp/compose.previous.yaml
   ssh nas.example 'cat ~/bluray-server/compose.yaml' | diff /tmp/compose.previous.yaml -
   ```

   No difference, or only differences you made on purpose and want kept, before going on.

3. **Create `.env.local`** at the repo root (gitignored):

   ```sh
   BLURAY_NAS_HOST=nas.example
   BLURAY_CADDY_SITE=https://nas.example.com
   ```

   `BLURAY_CADDY_SITE` is the site address exactly as the Caddyfile writes it.

4. **Migrate:** `server/deploy/deploy.sh --migrate`. It deploys nothing and doesn't touch the running service. It keeps
   the previous file as `~/bluray-server/compose.yaml.pre-generic`, appends the previous file's values to
   `~/bluray-server/.env` (a dated copy of the old `.env` is kept beside it) and writes
   `~/bluray-server/compose.override.yaml` with the drive mounts and the proxy's network. If it stops with a message,
   fix what it names and run it again; a rerun adds only what is missing.

5. **Check what it wrote** on the NAS: `.env` has `PUBLIC_BASE`, `LIBRARY_ROOTS`, `LIBRARY_MOUNT`, `RENDEZVOUS_URL`,
   `RTC_LAN_ADDRESS`, `TRUSTED_PROXY` and the rest of the previous file's values, with your secrets untouched, and
   `compose.override.yaml` lists every drive mount (read-only) and the proxy's network as external. To see the service
   the generic file will give, without writing or starting anything, and compare it with the previous one, print
   only mounts, networks, ports and environment key names. Never print `docker compose config` as it is: it resolves
   `.env` and `${...}` and would show `TMDB_API_KEY`, `DISCOGS_TOKEN` and the other secrets. `--no-interpolate` and
   `--no-env-resolution` keep it from reading values, and the `jq` filter drops what is left of them (the generic file
   goes in on stdin):

   ```sh
   F='.services | map_values({image, ports, volumes, networks, env_keys: ((.environment // {}) | keys)})'
   ssh nas.example 'cd ~/bluray-server && docker compose -f - -f compose.override.yaml config --no-interpolate --no-env-resolution --format json' < server/deploy/compose.yaml | jq -S "$F"
   ssh nas.example 'cd ~/bluray-server && docker compose -f compose.yaml.pre-generic config --no-interpolate --no-env-resolution --format json' | jq -S "$F"
   ssh nas.example "cd ~/bluray-server && sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' .env"
   ```

   The last command lists the names in `.env` (names only). Do not paste any of this output into a chat, an issue or a
   log, and if a value ever shows, treat that secret as exposed and replace it. Compare: the same mounts, networks and
   UDP port in both, the same environment names (the generic file takes the `.env` names through `env_file`), and the
   generic one adds only the `/library` bind of `LIBRARY_MOUNT`.

6. **Deploy:** `server/deploy/deploy.sh`. It refuses while the migration is missing or half done (no `PUBLIC_BASE`,
   or `.env` migrated but no override, or the previous compose file with no override); run `--migrate` again then.
   Otherwise it writes the generic `compose.yaml`, starts the service with `-f compose.yaml [-f compose.gpu.yaml]
   -f compose.override.yaml` and reloads Caddy (never restarts it).

7. **Check the service:**
   - health through Caddy: `curl -fsS https://nas.example.com/bluray/api/health`;
   - the container is on the proxy's network:
     `ssh nas.example "docker inspect bluray-server --format '{{json .NetworkSettings.Networks}}'"`;
   - the library roots: `ssh nas.example 'docker logs --since 10m bluray-server'` shows the scan finding every root,
     and the app's library lists the same discs as before;
   - one pairing by a typed code (mint one with `deploy.sh --owner-code`) and one WebRTC reconnect (a device away from
     your network, or with the LAN route blocked, opens a disc).

8. **Get the NAS id:** `server/deploy/deploy.sh --nas-id`.

9. **Lock the Worker to it** (from `rendezvous/`, comma-separated if there is more than one NAS):

   ```sh
   cd rendezvous && npx wrangler@4.148.0 secret put NAS_IDS
   ```

   For the relay the same id goes on `TURN_NAS_IDS` too.

10. **Check again:** a typed-code lookup and pairing, and a WebRTC reconnect, now through the locked Worker. If the
    NAS gets 403 `nas-not-allowed`, the id in `NAS_IDS` is wrong: put the right one, or delete the secret to open the
    Worker again.

11. **Make the image public:** on GitHub, the `bluray-server` package's settings, change its visibility to public (a new
    package is private), so self-hosters can pull `ghcr.io/brianhvo02/bluray-server`.

If something goes wrong after step 6, the previous file is still on the NAS as `compose.yaml.pre-generic`. This restores
the previous configuration, not the previous image (the deploy replaced the image tag):
`cd ~/bluray-server && docker compose -f compose.yaml.pre-generic [-f compose.gpu.yaml] up -d`, with `-f compose.gpu.yaml`
only when `/dev/dri/renderD128` exists on the NAS.
