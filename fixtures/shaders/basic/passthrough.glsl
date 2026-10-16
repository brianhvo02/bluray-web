//!HOOK MAIN
//!BIND HOOKED
//!DESC passthrough

vec4 hook() {
    return HOOKED_tex(HOOKED_pos);
}
