//!HOOK MAIN
//!BIND HOOKED
//!WHEN OUTPUT.w MAIN.w / 1.200 >
//!DESC when skip

vec4 hook() {
    return HOOKED_tex(HOOKED_pos);
}
