/* BD-J trace harness: plays a disc headless through patched libbluray with BD-J enabled. The patch prints one JSONL
 * line per JNI native call to stdout; this program prints nothing there (diagnostics go to stderr).
 * usage: bdj_trace <disc> [--seconds N]
 * Reads the stream no faster than real time, so BD-J timers and playback progress behave roughly as on a player. */
#include <libbluray/bluray.h>
#include <libbluray/overlay.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static struct timespec t0;
static double now_s(void)
{
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)(t.tv_sec - t0.tv_sec) + (double)(t.tv_nsec - t0.tv_nsec) / 1e9;
}

static void argb(void *h, const BD_ARGB_OVERLAY *ov)
{
  (void)h;
  (void)ov;
}

int main(int argc, char **argv)
{
  const char *disc = NULL;
  double limit = 60;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--seconds") && i + 1 < argc) {
      limit = atof(argv[++i]);
    } else if (!disc) {
      disc = argv[i];
    } else {
      disc = NULL;
      break;
    }
  }
  if (!disc) {
    fprintf(stderr, "usage: %s <disc> [--seconds N]\n", argv[0]);
    return 2;
  }
  clock_gettime(CLOCK_MONOTONIC, &t0);

  BLURAY *bd = bd_open(disc, NULL);
  if (!bd) {
    fprintf(stderr, "bd_open failed\n");
    return 1;
  }
  bd_register_argb_overlay_proc(bd, NULL, argb, NULL);
  bd_set_player_setting_str(bd, BLURAY_PLAYER_SETTING_COUNTRY_CODE, "us");
  bd_set_player_setting_str(bd, BLURAY_PLAYER_SETTING_AUDIO_LANG, "eng");
  bd_set_player_setting_str(bd, BLURAY_PLAYER_SETTING_PG_LANG, "eng");
  bd_set_player_setting_str(bd, BLURAY_PLAYER_SETTING_MENU_LANG, "eng");
  if (!bd_play(bd)) {
    fprintf(stderr, "bd_play failed\n");
    return 1;
  }

  static unsigned char buf[6144 * 32];
  double playlist_wall = 0;
  while (now_s() < limit) {
    BD_EVENT ev;
    int n = bd_read_ext(bd, buf, sizeof buf, &ev);
    for (;;) {
      if (ev.event == BD_EVENT_PLAYLIST) {
        playlist_wall = now_s();
      }
      if (!bd_get_event(bd, &ev)) {
        break;
      }
    }
    if (n < 0) {
      fprintf(stderr, "read error\n");
      break;
    }
    if (n == 0) {
      usleep(40000);
      continue;
    }
    /* pace: stream time since the playlist started must not run ahead of wall time */
    double ahead = (double)bd_tell_time(bd) / 90000.0 - (now_s() - playlist_wall);
    if (ahead > 0.5) {
      usleep((useconds_t)((ahead - 0.5) * 1e6));
    }
  }
  fflush(stdout);
  bd_close(bd);
  return 0;
}
