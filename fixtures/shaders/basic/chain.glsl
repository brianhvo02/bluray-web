//!HOOK MAIN
//!BIND HOOKED
//!SAVE TINT
//!COMPONENTS 1
//!DESC tint

vec4 hook() {
    return vec4(HOOKED_tex(HOOKED_pos).r, 0.0, 0.0, 1.0);
}

//!HOOK MAIN
//!BIND HOOKED
//!BIND TINT
//!DESC combine

vec4 hook() {
    return HOOKED_tex(HOOKED_pos) * TINT_tex(TINT_pos).x;
}
