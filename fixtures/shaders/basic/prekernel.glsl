//!HOOK PREKERNEL
//!BIND HOOKED
//!DESC prekernel

vec4 hook() {
    return HOOKED_tex(HOOKED_pos);
}
