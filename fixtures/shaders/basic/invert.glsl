//!HOOK MAIN
//!BIND HOOKED
//!DESC invert

vec4 hook() {
    return vec4(1.0 - HOOKED_tex(HOOKED_pos).rgb, 1.0);
}
