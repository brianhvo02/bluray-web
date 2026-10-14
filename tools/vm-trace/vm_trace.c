/*
 * vm_trace: runs a disc through patched libbluray (see trace.patch) and prints a JSON-lines trace of
 * register writes and player events. Usage: vm_trace <disc-dir> <script-file>
 *
 * Trace and script formats: tests/vm-trace/format.ts and tests/vm-trace/script.ts.
 * Waits are state-based ("the current title is N"), and steps run only once the VM has settled, so the
 * trace does not depend on how libbluray splits its work over bd_read_ext() calls.
 */
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "libbluray/bluray.h"
#include "libbluray/keys.h"
#include "libbluray/decoders/overlay.h"

extern void (*bd_trace_write_cb)(int psr, int reg, uint32_t val);
extern void (*bd_trace_event_cb)(uint32_t event, uint32_t param);
extern void bd_trace_tick(void);
extern int bd_trace_finished(BLURAY *bd);

#define READ_SIZE   6144
#define MAX_READS   10000000
#define TAIL_READS  200
#define MAX_SETTLE  100000
#define PSR_TIME    8
#define PLANE_W     1920
#define PLANE_H     1080

/* ---- state seen through the trace callbacks ---- */

static int tracing;
static long last_title = -1, last_playlist = -1;
static int menu_open, popup_open, errored, ended;

static void emit_value(const char *kind, uint32_t v)
{
    printf("{\"k\":\"%s\",\"v\":%" PRIu32 "}\n", kind, v);
}

static void write_cb(int psr, int reg, uint32_t val)
{
    if (!tracing || (psr && reg == PSR_TIME)) {
        return;
    }
    printf("{\"k\":\"%s\",\"i\":%d,\"v\":%" PRIu32 "}\n", psr ? "psr" : "gpr", reg, val);
}

static void event_cb(uint32_t event, uint32_t param)
{
    if (!tracing) {
        return;
    }
    switch (event) {
        case BD_EVENT_TITLE:
            last_title = param;
            emit_value("title", param);
            break;
        case BD_EVENT_PLAYLIST:
            last_playlist = param;
            emit_value("playlist", param);
            break;
        case BD_EVENT_PLAYITEM:
            emit_value("playitem", param);
            break;
        case BD_EVENT_CHAPTER:
            emit_value("chapter", param);
            break;
        case BD_EVENT_MENU:
            menu_open = !!param;
            emit_value("menu", !!param);
            break;
        case BD_EVENT_POPUP:
            popup_open = !!param;
            emit_value("popup", !!param);
            break;
        case BD_EVENT_UO_MASK_CHANGED:
            printf("{\"k\":\"uo\",\"v\":\"%" PRIx32 "\"}\n", param);
            break;
        case BD_EVENT_SOUND_EFFECT:
            emit_value("sound", param);
            break;
        case BD_EVENT_STILL:
            emit_value("still", !!param);
            break;
        case BD_EVENT_ERROR:
            errored = 1;
            break;
        default:
            break;
    }
}

/* ---- IG overlay: kept as an 8-bit palette-index plane (hashed by Task 13) ---- */

static uint8_t ig_plane[PLANE_W * PLANE_H];
static BD_PG_PALETTE_ENTRY ig_palette[256];
static int ig_open;

static void overlay_proc(void *handle, const struct bd_overlay_s * const ov)
{
    unsigned x, y, i, n;
    (void)handle;

    if (!ov || ov->plane != BD_OVERLAY_IG) {
        return;
    }
    switch (ov->cmd) {
        case BD_OVERLAY_INIT:
            memset(ig_plane, 0xff, sizeof(ig_plane));
            ig_open = 1;
            break;
        case BD_OVERLAY_CLOSE:
            ig_open = 0;
            break;
        case BD_OVERLAY_CLEAR:
            memset(ig_plane, 0xff, sizeof(ig_plane));
            break;
        case BD_OVERLAY_WIPE:
            for (y = ov->y; y < (unsigned)ov->y + ov->h && y < PLANE_H; y++) {
                for (x = ov->x; x < (unsigned)ov->x + ov->w && x < PLANE_W; x++) {
                    ig_plane[y * PLANE_W + x] = 0xff;
                }
            }
            break;
        case BD_OVERLAY_DRAW:
            if (ov->palette) {
                memcpy(ig_palette, ov->palette, sizeof(ig_palette));
            }
            if (ov->img) {
                x = ov->x;
                y = ov->y;
                n = 0;
                for (i = 0; n < (unsigned)ov->w * ov->h; i++) {
                    unsigned run = ov->img[i].len;
                    if (!run) {
                        break;
                    }
                    while (run--) {
                        unsigned px = x + n % ov->w, py = y + n / ov->w;
                        if (px < PLANE_W && py < PLANE_H) {
                            ig_plane[py * PLANE_W + px] = (uint8_t)ov->img[i].color;
                        }
                        n++;
                    }
                }
            }
            break;
        default:
            break;
    }
}

/* ---- script ---- */

typedef enum { S_WAIT_TITLE, S_WAIT_PLAYLIST, S_WAIT_MENU, S_WAIT_POPUP, S_WAIT_END, S_KEY, S_MOUSE, S_CLICK, S_PLAY_TITLE } step_kind;
typedef struct { step_kind kind; int a, b; } step_t;

static const struct { const char *name; uint32_t vk; } KEYS[] = {
    { "up", BD_VK_UP }, { "down", BD_VK_DOWN }, { "left", BD_VK_LEFT }, { "right", BD_VK_RIGHT },
    { "ok", BD_VK_ENTER }, { "topmenu", BD_VK_ROOT_MENU }, { "popup", BD_VK_POPUP },
};

static int parse_script(const char *path, step_t **out)
{
    FILE *f = fopen(path, "r");
    char line[256];
    int n = 0, cap = 0;
    step_t *steps = NULL;

    if (!f) {
        return -1;
    }
    while (fgets(line, sizeof(line), f)) {
        char w1[32] = "", w2[32] = "";
        int a = 0, b = 0, cnt;
        step_t s = { S_WAIT_END, 0, 0 };
        char *hash = strchr(line, '#');
        if (hash) {
            *hash = 0;
        }
        cnt = sscanf(line, "%31s %31s %d %d", w1, w2, &a, &b);
        if (cnt < 1) {
            continue;
        }
        if (!strcmp(w1, "wait") && cnt >= 2) {
            if (!strcmp(w2, "title")) { s.kind = S_WAIT_TITLE; s.a = a; }
            else if (!strcmp(w2, "playlist")) { s.kind = S_WAIT_PLAYLIST; s.a = a; }
            else if (!strcmp(w2, "menu")) s.kind = S_WAIT_MENU;
            else if (!strcmp(w2, "popup")) s.kind = S_WAIT_POPUP;
            else if (!strcmp(w2, "end")) s.kind = S_WAIT_END;
            else goto bad;
        } else if (!strcmp(w1, "key") && cnt >= 2) {
            unsigned i;
            int found = 0;
            s.kind = S_KEY;
            if (w2[0] >= '0' && w2[0] <= '9' && !w2[1]) {
                s.a = BD_VK_0 + (w2[0] - '0');
                found = 1;
            }
            for (i = 0; !found && i < sizeof(KEYS) / sizeof(KEYS[0]); i++) {
                if (!strcmp(w2, KEYS[i].name)) {
                    s.a = (int)KEYS[i].vk;
                    found = 1;
                }
            }
            if (!found) goto bad;
        } else if ((!strcmp(w1, "mouse") || !strcmp(w1, "click")) && cnt == 3) {
            /* sscanf read "X" into w2 */
            s.kind = w1[0] == 'm' ? S_MOUSE : S_CLICK;
            s.a = atoi(w2);
            s.b = a;
        } else if (!strcmp(w1, "play") && !strcmp(w2, "title") && cnt >= 3) {
            s.kind = S_PLAY_TITLE;
            s.a = a;
        } else {
            goto bad;
        }
        if (n == cap) {
            cap = cap ? cap * 2 : 16;
            steps = realloc(steps, cap * sizeof(*steps));
        }
        steps[n++] = s;
        continue;
bad:
        fprintf(stderr, "bad script line: %s", line);
        fclose(f);
        free(steps);
        return -1;
    }
    fclose(f);
    *out = steps;
    return n;
}

static int wait_met(const step_t *s)
{
    switch (s->kind) {
        case S_WAIT_TITLE: return last_title == s->a;
        case S_WAIT_PLAYLIST: return last_playlist == s->a;
        case S_WAIT_MENU: return menu_open;
        case S_WAIT_POPUP: return popup_open;
        case S_WAIT_END: return ended;
        default: return 1;
    }
}

/* Runs the VM until it is suspended and the event queue is empty, without reading stream data. */
static void settle(BLURAY *bd)
{
    BD_EVENT ev;
    int i;
    for (i = 0; i < MAX_SETTLE; i++) {
        bd_read_ext(bd, NULL, 0, &ev);
        if (ev.event == BD_EVENT_NONE) {
            break;
        }
    }
    ended = bd_trace_finished(bd);
}

static void run_step(BLURAY *bd, const step_t *s)
{
    switch (s->kind) {
        case S_KEY: bd_user_input(bd, -1, (uint32_t)s->a); break;
        case S_MOUSE: bd_mouse_select(bd, -1, (uint16_t)s->a, (uint16_t)s->b); break;
        case S_CLICK:
            bd_mouse_select(bd, -1, (uint16_t)s->a, (uint16_t)s->b);
            bd_user_input(bd, -1, BD_VK_MOUSE_ACTIVATE);
            break;
        case S_PLAY_TITLE: bd_play_title(bd, (unsigned)s->a); break;
        default: break;
    }
}

static void finish(const char *why)
{
    printf("{\"k\":\"end\",\"why\":\"%s\"}\n", why);
    fflush(stdout);
}

int main(int argc, char **argv)
{
    static uint8_t buf[READ_SIZE];
    step_t *steps = NULL;
    int nsteps, idx = 0, tail = 0;
    long reads;
    BD_EVENT ev;
    BLURAY *bd;

    if (argc != 3) {
        fprintf(stderr, "usage: %s <disc-dir> <script-file>\n", argv[0]);
        return 2;
    }
    nsteps = parse_script(argv[2], &steps);
    if (nsteps < 0) {
        fprintf(stderr, "cannot read script %s\n", argv[2]);
        return 2;
    }
    bd = bd_open(argv[1], NULL);
    if (!bd) {
        fprintf(stderr, "bd_open(%s) failed\n", argv[1]);
        return 2;
    }

    /* creates the event queue and queues libbluray's initial PSR events, which are not part of the trace */
    bd_get_event(bd, NULL);
    while (bd_get_event(bd, &ev) && ev.event != BD_EVENT_NONE) {
    }
    bd_register_overlay_proc(bd, NULL, overlay_proc);

    bd_trace_write_cb = write_cb;
    bd_trace_event_cb = event_cb;
    tracing = 1;

    if (!bd_play(bd)) {
        fprintf(stderr, "bd_play failed\n");
    }

    for (reads = 0; reads < MAX_READS; reads++) {
        settle(bd);
        while (idx < nsteps && !errored && wait_met(&steps[idx])) {
            run_step(bd, &steps[idx]);
            settle(bd);
            printf("{\"k\":\"step\",\"n\":%d}\n", idx);
            idx++;
        }
        if (errored) {
            finish("error");
            return 0;
        }
        if (idx == nsteps && (ended || tail++ >= TAIL_READS)) {
            finish("eof");
            return 0;
        }

        bd_trace_tick();
        bd_read_ext(bd, buf, READ_SIZE, &ev);
    }
    finish("limit");
    free(steps);
    return 0;
}
